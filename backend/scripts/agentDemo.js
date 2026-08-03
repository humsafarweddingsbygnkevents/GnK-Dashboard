'use strict';

// Hwoli agent demo — no network calls.
//
// Prints (A) the exact system prompt sent to the model, then (B) a full
// tool-call loop trace using a MOCK llm but the REAL orchestrator, REAL tools,
// and the REAL database. A throwaway client is created and deleted so live
// data is untouched.
//
//   node scripts/agentDemo.js
//   node scripts/agentDemo.js --prompt-only

// --- minimal .env loader (so Prisma sees DATABASE_URL when run standalone) ---
const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const { PrismaClient } = require('@prisma/client');
const { buildSystemPrompt } = require('../src/lib/agent/systemPrompt');
const { TOOL_DESCRIPTIONS } = require('../src/lib/agent/tools');
const { runAgentTurn, extractJson } = require('../src/lib/agent/orchestrator');

const prisma = new PrismaClient();

const RULE = '='.repeat(78);
const INBOUND_MESSAGE =
  "Hi! We're planning our wedding reception in Jim Corbett around 14 November 2026, " +
  "expecting about 250 guests. We'd love a jungle resort with a full buyout option. " +
  'What can you suggest?';

// ---------------------------------------------------------------------------
// Mock LLM. Returns scripted "model" outputs by call index. Deliberately uses
// three different formats to prove the JSON extractor is robust:
//   call 1 -> clean raw JSON
//   call 2 -> ```json fenced JSON
//   call 3 -> prose + JSON (built from the real searchHotels result)
// ---------------------------------------------------------------------------
function makeMockLlm() {
  let call = 0;
  return async function mockLlm(messages) {
    call += 1;

    if (call === 1) {
      return JSON.stringify({
        action: 'tool_call',
        tool: 'logClientDetails',
        args: {
          preferredCity: 'Jim Corbett',
          mustHaveFeatures: 'Jungle resort, full buyout',
          functions: [{ type: 'reception', date: '2026-11-14', city: 'Jim Corbett', guestCount: 250 }],
        },
      });
    }

    if (call === 2) {
      // fenced — extractJson must strip the ```json fence
      return '```json\n' +
        JSON.stringify({
          action: 'tool_call',
          tool: 'searchHotels',
          args: { city: 'Jim Corbett', minRooms: 90, limit: 3 },
        }) +
        '\n```';
    }

    // call 3: build a data-driven reply from the latest searchHotels result,
    // then wrap it in prose to prove the balanced-brace extractor works.
    let hotels = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && m.content.startsWith('TOOL_RESULT searchHotels:')) {
        const parsed = extractJson(m.content.slice('TOOL_RESULT searchHotels:'.length));
        hotels = (parsed && parsed.hotels) || [];
        break;
      }
    }
    const top = hotels.slice(0, 2).map((h) => {
      const buyout = h.buyoutPrice ? ` (buyout ~₹${h.buyoutPrice})` : '';
      const cap = h.guestCapacity ? `, up to ${h.guestCapacity} guests` : '';
      return `${h.name}${cap}${buyout}`;
    });
    const list = top.length ? top.join('; ') : 'a shortlist of jungle resorts';
    const reply =
      `Congratulations on your reception! Jim Corbett is a beautiful choice for a jungle-side ` +
      `celebration of 250 guests. A couple of options that fit: ${list}. ` +
      `I've noted your date (14 Nov 2026), city and full-buyout preference — our specialist ` +
      `will follow up with availability and tailored quotes shortly.`;

    return `Here is my reply to the client: ${JSON.stringify({ action: 'final_reply', content: reply })}`;
  };
}

function short(obj, n = 600) {
  const s = JSON.stringify(obj);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

(async () => {
  // ===== (A) system prompt =====
  console.log(RULE);
  console.log('(A) FULL SYSTEM PROMPT SENT TO THE MODEL');
  console.log(RULE);
  console.log(buildSystemPrompt(TOOL_DESCRIPTIONS));
  console.log('');

  if (process.argv.includes('--prompt-only')) {
    await prisma.$disconnect();
    return;
  }

  // ===== (B) full tool-call loop trace on a throwaway client =====
  const demoClient = await prisma.client.create({
    data: { name: 'DEMO — Agent Trace', source: 'test', status: 'new' },
  });

  try {
    console.log(RULE);
    console.log('(B) FULL TOOL-CALL LOOP TRACE (mock LLM, real tools, real DB)');
    console.log(RULE);
    console.log(`\nINBOUND (client ${demoClient.id}):\n  "${INBOUND_MESSAGE}"\n`);

    const result = await runAgentTurn(
      [{ role: 'user', content: INBOUND_MESSAGE }],
      demoClient.id,
      { llm: makeMockLlm() },
    );

    let step = 0;
    for (const t of result.trace) {
      if (t.type === 'tool_call') {
        step += 1;
        console.log(`STEP ${step} — TOOL CALL  [iteration ${t.iteration}]`);
        console.log(`  tool : ${t.tool}`);
        console.log(`  args : ${short(t.args)}`);
        console.log(`  ↳ result: ${short(t.result)}\n`);
      } else if (t.type === 'final_reply') {
        console.log(`FINAL REPLY  [iteration ${t.iteration}]`);
        console.log(`  ${t.content}\n`);
      } else {
        console.log(`(${t.type}) ${short(t)}\n`);
      }
    }

    console.log(RULE);
    console.log(`SUMMARY: iterations=${result.iterations}  fallback=${result.fallback}` +
      (result.reason ? `  reason=${result.reason}` : ''));
    console.log(`tool calls: ${result.trace.filter((t) => t.type === 'tool_call').map((t) => t.tool).join(' -> ')}`);

    // Show what actually got written to the throwaway client's profile.
    const saved = await prisma.client.findUnique({
      where: { id: demoClient.id },
      include: { functions: true },
    });
    console.log('\nPERSISTED PROFILE (proves logClientDetails wrote correctly):');
    console.log('  ' + short({
      preferredCity: saved.preferredCity,
      mustHaveFeatures: saved.mustHaveFeatures,
      functions: saved.functions.map((f) => ({
        type: f.type, date: f.date, city: f.city, guestCount: f.guestCount,
      })),
    }));
    console.log(RULE);
  } finally {
    // Clean up — cascade removes the demo client's functions too.
    await prisma.client.delete({ where: { id: demoClient.id } });
    await prisma.$disconnect();
  }
})().catch(async (err) => {
  console.error('demo failed:', err);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
