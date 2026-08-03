'use strict';

// LLM triage for inbound messages (Instagram DMs, Facebook Messenger, Gmail).
//
// One classification call per message: buckets the sender into a category
// (event_enquiry / collaboration / job_internship / general) and extracts any
// client details they mentioned (phone, email, city, event date, guest count,
// budget). The result is upserted into the Client table so every enquiry shows
// up in the dashboard's Clients section with the right source + category.
//
// The LLM path degrades gracefully: if OPENROUTER_* is unset or the call
// fails, a keyword heuristic still assigns a category — a webhook delivery
// must never be lost because the classifier was unavailable.

const prisma = require('../prisma');
const { callOpenRouter, extractJson } = require('./orchestrator');

const CATEGORIES = ['event_enquiry', 'collaboration', 'job_internship', 'general'];

// Free-tier OpenRouter models are individually flaky (upstream rate limits,
// slugs getting retired), so classification tries a chain: the configured
// OPENROUTER_MODEL first, then these — first parseable answer wins.
const FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'poolside/laguna-m.1:free',
];
const PER_MODEL_TIMEOUT_MS = 20000;

const CATEGORY_LABELS = {
  event_enquiry: 'Event Enquiry',
  collaboration: 'Collaboration',
  job_internship: 'Job / Internship',
  general: 'General',
};

const CLASSIFY_PROMPT = `You are the message-triage system for Humsafar Weddings by GnK, a wedding and event planning company in India. Staff see your output in their client dashboard.

Classify the inbound message below and extract any details the sender shared about themselves. Reply with RAW JSON only — a single object, no markdown fences, no commentary:

{
  "category": "event_enquiry" | "collaboration" | "job_internship" | "general",
  "name": string or null,
  "phone": string or null,
  "email": string or null,
  "city": string or null,
  "eventDate": "YYYY-MM-DD" or null,
  "guestCount": number or null,
  "budgetLakhs": number or null,
  "summary": "one short sentence describing what the sender wants"
}

Category rules:
- "event_enquiry": a potential client asking about weddings, events, venues, pricing, packages, availability, dates, decor, catering, or planning services.
- "collaboration": influencers, photographers, makeup artists, vendors, venues, or brands proposing a partnership, collab, promotion, barter, or cross-posting.
- "job_internship": someone asking for a job, internship, freelance work, or to join the team.
- "general": greetings, spam, unclear one-liners, or anything that fits none of the above.

Extraction rules:
- Only extract details the sender explicitly stated. Never invent values.
- "name" is the sender's own name if they introduced themselves in the text.
- Normalize Indian phone numbers to digits (keep +91 prefix if given).
- "budgetLakhs" is their event budget converted to lakhs of rupees (e.g. "20 lakh budget" -> 20, "1 crore" -> 100).`;

// --- keyword fallback (used when the LLM is unavailable) ---------------------
const HEURISTICS = [
  { category: 'job_internship', re: /\b(job|intern(ship)?|hiring|vacanc|opening|resume|cv\b|freelanc|work with you|join (your|the) team|career)/i },
  { category: 'collaboration', re: /\b(collab|partner(ship)?|influencer|barter|promot|sponsor|brand deal|cross[- ]?post|tie[- ]?up|vendor registration|feature (us|me))/i },
  { category: 'event_enquiry', re: /\b(wedding|shaadi|marriage|engagement|sangeet|mehendi|haldi|reception|venue|banquet|event|function|book|price|pricing|package|quotation|quote|budget|guest|pax|destination|decor|caterin|planner|planning|date[s]? available|availab)/i },
];

function heuristicClassify(text) {
  const t = String(text || '');
  for (const h of HEURISTICS) {
    if (h.re.test(t)) return h.category;
  }
  return 'general';
}

// Regex safety net for contact details — free-tier LLMs occasionally omit a
// phone number that's plainly in the text, and the heuristic path extracts
// nothing at all. Same patterns the Python enrichment pipeline uses.
const PHONE_RE = /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/;
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}\b/;

function fillContactFromText(text, result) {
  const t = String(text || '');
  if (!result.phone) {
    const m = t.match(PHONE_RE);
    if (m) result.phone = m[0].replace(/[\s-]/g, '');
  }
  if (!result.email) {
    const m = t.match(EMAIL_RE);
    if (m) result.email = m[0];
  }
  return result;
}

// --- normalization helpers ----------------------------------------------------
function cleanString(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

function cleanNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanDate(v) {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Classify one inbound message. Never throws.
 * @returns {Promise<{category, name, phone, email, city, eventDate, guestCount, budgetLakhs, summary, via}>}
 */
async function classifyMessage(text, { senderName = null, channel = 'instagram' } = {}) {
  const fallback = {
    category: heuristicClassify(text),
    name: null, phone: null, email: null, city: null,
    eventDate: null, guestCount: null, budgetLakhs: null,
    summary: null, via: 'heuristic',
  };
  if (!text || !String(text).trim()) return { ...fallback, category: 'general' };
  if (!process.env.OPENROUTER_API_KEY) return fallback;

  const user =
    `Channel: ${channel}` +
    (senderName ? `\nSender profile name: ${senderName}` : '') +
    `\nMessage:\n"""${String(text).slice(0, 4000)}"""`;
  const messages = [
    { role: 'system', content: CLASSIFY_PROMPT },
    { role: 'user', content: user },
  ];

  const models = [...new Set([process.env.OPENROUTER_MODEL, ...FALLBACK_MODELS].filter(Boolean))];
  for (const model of models) {
    let raw;
    try {
      raw = await callOpenRouter(messages, { model, timeoutMs: PER_MODEL_TIMEOUT_MS });
    } catch (err) {
      console.error(`[classifier] ${model} failed (${String(err.message).slice(0, 160)}) — trying next`);
      continue;
    }
    const parsed = extractJson(raw);
    if (!parsed || !CATEGORIES.includes(parsed.category)) {
      console.error(`[classifier] ${model} returned unparseable output — trying next: ${String(raw).slice(0, 160)}`);
      continue;
    }
    return fillContactFromText(text, {
      category: parsed.category,
      name: cleanString(parsed.name),
      phone: cleanString(parsed.phone),
      email: cleanString(parsed.email),
      city: cleanString(parsed.city),
      eventDate: cleanDate(parsed.eventDate),
      guestCount: cleanNumber(parsed.guestCount) ? Math.round(cleanNumber(parsed.guestCount)) : null,
      budgetLakhs: cleanNumber(parsed.budgetLakhs),
      summary: cleanString(parsed.summary),
      via: model,
    });
  }
  console.error('[classifier] all LLM models failed — using keyword heuristic');
  return fillContactFromText(text, fallback);
}

// A client name is a "placeholder" when it was auto-generated from an ID
// rather than a real person's name — safe to overwrite with something better.
function isPlaceholderName(name, channelUserId) {
  if (!name) return true;
  if (channelUserId && name === channelUserId) return true;
  return /^(instagram|facebook|gmail) (user|enquiry)/i.test(name) || name === 'New enquiry';
}

/**
 * Create or update the Client record for an inbound channel message.
 * Staff-entered data always wins: existing non-null fields are never
 * overwritten, only filled in. Never throws.
 *
 * @param {object} p
 * @param {'instagram'|'facebook'|'gmail'} p.source
 * @param {string} p.channelUserId  IGSID / PSID / email address
 * @param {string|null} p.senderName  resolved profile name, if any
 * @param {string} p.text  message text to classify
 * @param {Date}   [p.timestamp]  message time (defaults to now)
 * @returns {Promise<{client, created, classification}|null>}
 */
async function upsertClientFromMessage({ source, channelUserId, senderName = null, text, timestamp = new Date() }) {
  try {
    const existing = await prisma.client.findUnique({
      where: { source_channelUserId: { source, channelUserId } },
    });

    if (!existing) {
      const c = await classifyMessage(text, { senderName, channel: source });
      const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1);
      const noteLines = [];
      if (c.summary) noteLines.push(c.summary);
      if (text && String(text).trim()) noteLines.push(`First message (${sourceLabel}): "${String(text).trim().slice(0, 300)}"`);

      const client = await prisma.client.create({
        data: {
          name: c.name || senderName || `${sourceLabel} user ${String(channelUserId).slice(-4)}`,
          phone: c.phone,
          email: c.email || (source === 'gmail' ? channelUserId : null),
          preferredCity: c.city,
          weddingDate: c.eventDate,
          guestCount: c.guestCount,
          budgetLakhs: c.budgetLakhs,
          notes: noteLines.join('\n') || null,
          category: c.category,
          source,
          channelUserId,
          status: 'new',
          lastContactAt: timestamp,
        },
      });
      console.log(`[classifier] created client ${client.id} (${source}/${channelUserId}) category=${c.category} via=${c.via}`);
      return { client, created: true, classification: c };
    }

    // Existing client: bump activity, then fill gaps only. Re-run the LLM only
    // when something useful is still missing — keeps cost bounded per sender.
    const data = { lastContactAt: timestamp };
    if (senderName && isPlaceholderName(existing.name, channelUserId)) data.name = senderName;

    const needsDetails = !existing.category || !existing.phone || !existing.email ||
                         !existing.preferredCity || !existing.guestCount;
    let classification = null;
    if (needsDetails && text && String(text).trim()) {
      const c = await classifyMessage(text, { senderName, channel: source });
      classification = c;
      if (!existing.category) data.category = c.category;
      if (!existing.phone && c.phone) data.phone = c.phone;
      if (!existing.email && c.email) data.email = c.email;
      if (!existing.preferredCity && c.city) data.preferredCity = c.city;
      if (!existing.guestCount && c.guestCount) data.guestCount = c.guestCount;
      if (!existing.budgetLakhs && c.budgetLakhs) data.budgetLakhs = c.budgetLakhs;
      if (!existing.weddingDate && c.eventDate) data.weddingDate = c.eventDate;
      if (c.name && isPlaceholderName(existing.name, channelUserId) && !data.name) data.name = c.name;
    }

    const client = await prisma.client.update({ where: { id: existing.id }, data });
    return { client, created: false, classification };
  } catch (err) {
    console.error(`[classifier] upsert failed for ${source}/${channelUserId}:`, err);
    return null;
  }
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  classifyMessage,
  heuristicClassify,
  upsertClientFromMessage,
};
