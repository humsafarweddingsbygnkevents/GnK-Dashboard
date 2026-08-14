'use strict';

// Simple .env loader — avoids a dotenv dependency. No-ops on Vercel (no .env
// file at runtime there; env vars come from the Vercel project settings).
const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

const express = require('express');
const cookieParser = require('cookie-parser');
const hotelsRouter = require('./routes/hotels');
const citiesRouter = require('./routes/cities');
const clientsRouter = require('./routes/clients');
const authRouter = require('./routes/auth');
const adminAuthRouter = require('./routes/adminAuth');
const gmailRouter = require('./routes/gmail');
const mailRouter = require('./routes/mail');
const messagesRouter = require('./routes/messages');
const newClientMessageRouter = require('./routes/webhook/newClientMessage');
const metaWebhookRouter = require('./routes/webhook/meta');
const requireAuth = require('./middleware/requireAuth');
const requireAdmin = require('./middleware/requireAdmin');
const employeesRouter = require('./routes/employees');
const attendanceRouter = require('./routes/attendance');
const feedbackRouter = require('./routes/feedback');

// Warn (don't crash) on missing Google OAuth vars — a serverless function
// cold-starts on every scale-up, so process.exit(1) here would take down
// every request, not just Gmail ones. Routes that actually need these vars
// already fail per-request with a clear error.
const REQUIRED_GOOGLE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
const missing = REQUIRED_GOOGLE_VARS.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`WARNING: Missing env vars: ${missing.join(', ')} — Gmail features will not work until these are set.`);
}
if (!process.env.JWT_SECRET) {
  console.error('WARNING: JWT_SECRET is not set — admin login/signup will fail until it is.');
}

const app = express();

// Trust exactly one hop (Vercel's edge proxy) so req.ip resolves from
// X-Forwarded-For instead of the proxy's own internal address. Without this,
// every request looks like it comes from the same IP, and the per-IP auth
// rate limiters below end up sharing ONE global bucket across all users.
app.set('trust proxy', 1);

// verify callback stashes the raw bytes on req.rawBody — needed to check the
// Meta webhook's X-Hub-Signature-256 header, which is computed over the raw
// (pre-parse) request body.
app.use(express.json({ limit: '30mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// CORS — the dashboard and API are always same-origin (Vercel rewrites, or
// the same local Express server), so no cross-origin requests are expected
// in normal use. Now that auth uses an httpOnly cookie, we don't reflect an
// arbitrary Origin with credentials enabled (that would let any site ride a
// logged-in admin's session) — only these known dashboard origins get CORS
// headers at all, and only non-credentialed requests otherwise.
const ALLOWED_ORIGINS = new Set([
  'https://dashboard.humsafarweddingsbygnk.in',
  'https://humsafar-gnk-dashboard.vercel.app',
  'http://localhost:3000',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Serve the dashboard from project root /dashboard. On Vercel this is also
// served as static output (see vercel.json), so this mainly matters for
// local dev (`npm run dev`), but is harmless to keep for both.
app.use(express.static(path.join(__dirname, '../../dashboard')));

// Admin login/signup — public, must come before the blanket /api auth gate below.
app.use('/api/auth', adminAuthRouter);

// Neither webhook's caller is a logged-in admin, so both stay public at the
// mount level — each verifies the request itself inside its own router: Meta
// via X-Hub-Signature-256, new-client-message via a shared-secret bearer
// token (HWOLI_WEBHOOK_SECRET).
app.use('/api/webhook', newClientMessageRouter);
app.use('/api/webhook', metaWebhookRouter);

// Everything else under /api (venue data, clients, Gmail inbox, Hwoli chat)
// is the private data this login system exists to protect.
app.use('/api', requireAuth);

// Attendance and feedback are surfaces both roles share — each router scopes
// employees to their own rows internally.
app.use('/api/attendance', attendanceRouter);
app.use('/api/feedback', feedbackRouter);

// Employees share the venue database, inbox, Hwoli chat, and client data
// with admins — only account management (Team) is admin-only.
app.use('/api/employees', requireAdmin, employeesRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/hotels', hotelsRouter);
app.use('/api/cities', citiesRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/mail', mailRouter);
app.use('/api/messages', messagesRouter);

// Gmail *integration* connect flow (routes/auth.js — separate from admin
// login) also needs to require an authenticated admin, so a bare guessed
// URL can't link a stranger's Google account to the shared company inbox.
app.use('/auth', requireAuth, requireAdmin, authRouter);

// Hwoli AI chat — proxies to OpenRouter. Always uses the server's own key —
// never a client-supplied one: a billable key living in the browser (even in
// localStorage) is one XSS bug away from being exfiltrated and run up by
// someone else, and there's no per-admin key storage to isolate the blast
// radius of that. One shared, server-side key is the safer default until
// there's an actual need for staff to bring their own.
app.post('/api/hwoli/chat', async (req, res) => {
  const { messages, systemContext } = req.body;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return res.status(400).json({ error: 'OpenRouter API key not configured on the server. Ask an admin to set OPENROUTER_API_KEY.' });
  }
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Fetch hotel summary for system context
  let hotelContext = '';
  try {
    const prisma = require('./lib/prisma');
    const [total, cities] = await Promise.all([
      prisma.hotel.count(),
      prisma.city.findMany({ select: { name: true, _count: { select: { hotels: true } } } }),
    ]);
    const cityList = cities.map(c => `${c.name} (${c._count.hotels} venues)`).join(', ');
    hotelContext = `You have access to ${total} venues across: ${cityList}.`;
  } catch (_) {
    hotelContext = 'You have access to the Humsafar Weddings by GnK venue database.';
  }

  const systemPrompt = `You are Hwoli, the AI assistant for Humsafar Weddings by GnK — a premium wedding planning company in India. You help the team find venues, manage clients, draft replies, and answer any business questions.

${hotelContext}${systemContext ? '\n\n' + systemContext : ''}

When the team asks about venues, search the provided database context and give specific recommendations with names, prices, capacities, and contact info. When asked about clients, reference the client data. When asked about emails, reference the inbox data. Be warm, concise, and professional. Use ₹ for prices. Always respond in English.

Your scope: venue recommendations, client info lookup, email summaries, drafting AND sending emails (see below), and wedding planning questions. You do NOT make bookings or send WhatsApp/Instagram/Facebook messages.

SENDING EMAIL:
Staff can ask you to send an email. When they explicitly want it SENT (wording like "send", "email them", "shoot them a mail and say…"), write the email AND append a machine-readable action block as the VERY LAST thing in your reply, formatted exactly as a fenced block tagged hwoli-action:

\`\`\`hwoli-action
{"action":"send_email","to":"recipient@example.com","subject":"...","body":"..."}
\`\`\`

Sending rules:
- Add the action block ONLY when staff want it actually sent. If they only say "draft"/"write" (no send), show the draft text with NO action block.
- Before the block, add one short line like: "Here's the email — review and hit Send below."
- "to" MUST be a real email address. If you don't have the recipient's address (it's not in the data context and staff didn't give it), DO NOT invent one — ask them for it and omit the action block.
- Sign off the body as "Warm regards,\\nTeam Humsafar Weddings by GnK".
- The action block must be a single line of valid JSON. Put nothing after it.

IMPORTANT: When staff ask "show me" or "list" something — give a proper formatted list from the data context, not a vague answer. You have full database access in the context above.`;

  try {
    const payload = JSON.stringify({
      // nex-agi/nex-n2-pro:free was retired by OpenRouter (404s now) — use the
      // configured model, falling back to a free slug verified working.
      model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    });

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://humsafarweddingsbygnk.com',
        'X-Title': 'Humsafar Weddings by GnK Dashboard',
      },
      body: payload,
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'No response from Hwoli.';
    res.json({ reply });
  } catch (err) {
    console.error('Hwoli chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// SPA fallback — serve dashboard for any non-API route
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
  res.sendFile(path.join(__dirname, '../../dashboard/index.html'));
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = app;
