'use strict';

// Agentic orchestrator for Hwoli's first-reply workflow.
//
// OpenRouter is used as a plain text-completion chat endpoint — there is NO
// native function-calling. The model is instructed (see systemPrompt.js) to
// emit one raw JSON action per turn; we parse it, run the tool, feed the
// result back, and loop until it emits a final_reply or we hit the cap.

const prisma = require('../prisma');
const { buildSystemPrompt } = require('./systemPrompt');
const { TOOL_REGISTRY, TOOL_DESCRIPTIONS } = require('./tools');

const MAX_ITERATIONS = 5;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Safe, warm reply used whenever the loop cannot produce a real one.
const FALLBACK_REPLY =
  'Thank you so much for reaching out to Humsafar Weddings by GnK! We would love to help you plan ' +
  'your celebration. One of our wedding specialists will be in touch with you very shortly. ' +
  'In the meantime, feel free to share your preferred city, your dates, and your guest count, ' +
  'and we will line up the perfect venues for you.';

// --- OpenRouter call (default LLM transport) --------------------------------
// opts.model overrides OPENROUTER_MODEL; opts.timeoutMs aborts a hung call
// (important on serverless, where an unbounded fetch can eat the whole
// function budget).
async function callOpenRouter(messages, opts = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  const model = opts.model || process.env.OPENROUTER_MODEL;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  if (!model) throw new Error('OPENROUTER_MODEL is not set');

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://humsafarweddingsbygnk.com',
      'X-Title': 'Humsafar Weddings by GnK — Hwoli Agent',
    },
    body: JSON.stringify({ model, messages, temperature: 0.3 }),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('OpenRouter returned no message content');
  return content;
}

// Pull the first balanced JSON object out of a model response. We instruct the
// model to emit raw JSON only, but tolerate ```json fences or stray prose.
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try { return JSON.parse(s); } catch (_) { /* fall through to scan */ }

  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/**
 * Run one agentic turn for a client's inbound message.
 *
 * @param {Array<{role:string,content:string}>} conversationHistory
 *        Chat history; the client's incoming message is the last user turn.
 * @param {number} clientId  Client this turn acts on (used by the tools).
 * @param {{ llm?: (messages:Array)=>Promise<string> }} [options]
 *        `llm` overrides the OpenRouter transport (used by tests/demos).
 * @returns {Promise<{reply, fallback, reason?, trace, iterations}>}
 */
async function runAgentTurn(conversationHistory, clientId, options = {}) {
  const llm = options.llm || callOpenRouter;
  const systemPrompt = buildSystemPrompt(TOOL_DESCRIPTIONS);
  const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];

  const ctx = { clientId, prisma };
  const trace = [];
  let jsonRetryUsed = false; // we retry malformed output exactly once

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let raw;
    try {
      raw = await llm(messages);
    } catch (err) {
      trace.push({ iteration, type: 'llm_error', error: err.message });
      return { reply: FALLBACK_REPLY, fallback: true, reason: 'llm_error', trace, iterations: iteration };
    }

    // Debug: surface the exact model output BEFORE any parsing. Gated so it's
    // off in normal operation. Set HWOLI_DEBUG_RAW=1 to inspect JSON quality.
    if (process.env.HWOLI_DEBUG_RAW) {
      console.log(`\n[hwoli:raw] iteration ${iteration} <<<RAW MODEL OUTPUT>>>\n${raw}\n[hwoli:raw] <<<END RAW>>>\n`);
    }

    const parsed = extractJson(raw);
    const validShape = parsed && (parsed.action === 'tool_call' || parsed.action === 'final_reply');

    if (!validShape) {
      // Malformed / wrong-shape output: retry once with a correction, else fallback.
      trace.push({ iteration, type: 'parse_error', raw: raw.slice(0, 500) });
      if (!jsonRetryUsed) {
        jsonRetryUsed = true;
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content:
            'Your previous message was not valid. Respond with valid JSON ONLY — a single object, ' +
            'no markdown, no commentary — exactly matching {"action":"tool_call","tool":"...","args":{...}} ' +
            'or {"action":"final_reply","content":"..."}.',
        });
        continue;
      }
      return { reply: FALLBACK_REPLY, fallback: true, reason: 'json_parse_failed', trace, iterations: iteration };
    }

    // Record the model's decision as the assistant turn (raw JSON it produced).
    messages.push({ role: 'assistant', content: raw });

    if (parsed.action === 'final_reply') {
      const content =
        typeof parsed.content === 'string' && parsed.content.trim()
          ? parsed.content.trim()
          : FALLBACK_REPLY;
      trace.push({ iteration, type: 'final_reply', content });
      return { reply: content, fallback: false, trace, iterations: iteration };
    }

    // action === 'tool_call'
    const toolName = parsed.tool;
    const args = parsed.args && typeof parsed.args === 'object' ? parsed.args : {};
    const tool = TOOL_REGISTRY[toolName];

    let result;
    if (!tool) {
      result = { error: `Unknown tool "${toolName}". Available: ${Object.keys(TOOL_REGISTRY).join(', ')}.` };
    } else {
      try {
        result = await tool(args, ctx);
      } catch (err) {
        result = { error: `Tool "${toolName}" failed: ${err.message}` };
      }
    }

    trace.push({ iteration, type: 'tool_call', tool: toolName, args, result });
    messages.push({ role: 'user', content: `TOOL_RESULT ${toolName}: ${JSON.stringify(result)}` });
  }

  // Ran out of iterations without a final_reply.
  trace.push({ type: 'max_iterations', max: MAX_ITERATIONS });
  return { reply: FALLBACK_REPLY, fallback: true, reason: 'max_iterations', trace, iterations: MAX_ITERATIONS };
}

module.exports = { runAgentTurn, extractJson, callOpenRouter, FALLBACK_REPLY, MAX_ITERATIONS };
