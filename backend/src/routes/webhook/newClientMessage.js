'use strict';

// Inbound webhook for a NEW client's first message.
//
// This is the ONLY place Hwoli acts autonomously: it replies instantly to a
// brand-new client's first message and logs any details mentioned. Once the
// client's status moves past "new", staff take over — Hwoli does not run
// ongoing conversations (CLAUDE.md scope rule).

const { Router } = require('express');
const prisma = require('../../lib/prisma');
const { runAgentTurn } = require('../../lib/agent/orchestrator');

const router = Router();

// Channels we accept first-messages from. Provenance (Client.source) is forced
// from this value server-side — never trusted from the request body.
const ALLOWED_CHANNELS = ['gmail', 'whatsapp', 'instagram', 'facebook', 'test'];

// Outbound delivery placeholder. Real channel sends (Gmail / Meta Graph API)
// are wired in later build stages (4–6); for now we log what WOULD be sent so
// the full agent loop can be exercised without faking a successful send.
async function deliverReply(channel, to, content) {
  console.log(`[hwoli] -> would deliver via ${channel} to ${JSON.stringify(to)}:\n${content}`);
  return { delivered: false, channel, reason: 'outbound channel not yet wired (build stage 5/6)' };
}

// POST /api/webhook/new-client-message
// Body: { channel, from?: { name?, phone?, email? }, message, clientId? }
router.post('/new-client-message', async (req, res) => {
  try {
    const { channel, from = {}, message, clientId } = req.body || {};

    if (!channel || !ALLOWED_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: `channel must be one of: ${ALLOWED_CHANNELS.join(', ')}` });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // --- Resolve the client: explicit id, else find-by-contact, else create ---
    let client = null;
    if (clientId !== undefined && clientId !== null) {
      const id = Number(clientId);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'clientId must be a positive integer' });
      }
      client = await prisma.client.findUnique({ where: { id } });
      if (!client) return res.status(404).json({ error: `Client with id ${id} not found` });
    } else {
      const phone = from.phone ? String(from.phone).trim() : null;
      const email = from.email ? String(from.email).trim() : null;
      if (phone || email) {
        client = await prisma.client.findFirst({
          where: { OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])] },
        });
      }
      if (!client) {
        client = await prisma.client.create({
          data: {
            name: (from.name && String(from.name).trim()) || phone || email || 'New enquiry',
            phone,
            email,
            source: channel, // provenance forced server-side
            status: 'new',
          },
        });
      }
    }

    // --- Hwoli only auto-replies to a brand-new client's FIRST message ---
    if (client.status !== 'new') {
      console.log(`[hwoli] skip: client ${client.id} status="${client.status}" — not a first message`);
      return res.json({ handled: false, reason: 'not_first_message', clientId: client.id });
    }

    // --- Run the agentic turn ---
    const conversationHistory = [{ role: 'user', content: message.trim() }];
    const result = await runAgentTurn(conversationHistory, client.id);

    // --- Log the full tool-call trace for debugging ---
    const toolCalls = result.trace.filter((t) => t.type === 'tool_call');
    console.log(`\n[hwoli] ===== agent run | client ${client.id} | channel ${channel} =====`);
    console.log(`[hwoli] inbound: ${message.trim()}`);
    for (const t of toolCalls) {
      console.log(`[hwoli]   tool: ${t.tool}  args=${JSON.stringify(t.args)}`);
      console.log(`[hwoli]         result=${JSON.stringify(t.result).slice(0, 500)}`);
    }
    console.log(`[hwoli] iterations: ${result.iterations}${result.fallback ? `  FALLBACK(${result.reason})` : ''}`);
    console.log(`[hwoli] reply: ${result.reply}`);
    console.log(`[hwoli] ============================================================\n`);

    // --- Deliver, then advance status so we never auto-reply twice ---
    const delivery = await deliverReply(
      channel,
      { name: client.name, phone: client.phone, email: client.email },
      result.reply,
    );
    await prisma.client.update({ where: { id: client.id }, data: { status: 'contacted' } });

    return res.json({
      handled: true,
      clientId: client.id,
      reply: result.reply,
      fallback: !!result.fallback,
      iterations: result.iterations,
      toolCalls: toolCalls.map((t) => ({ tool: t.tool, args: t.args })),
      delivery,
    });
  } catch (err) {
    console.error('[hwoli] webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
