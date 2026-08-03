'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');

// GET /api/messages?platform=instagram|facebook
router.get('/', async (req, res) => {
  const { platform } = req.query;
  if (!platform || !['instagram', 'facebook'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be "instagram" or "facebook"' });
  }

  try {
    const [messages, contacts] = await Promise.all([
      prisma.message.findMany({ where: { platform }, orderBy: { timestamp: 'desc' } }),
      prisma.messageContact.findMany({ where: { platform } }),
    ]);

    const contactBySenderId = new Map(contacts.map((c) => [c.senderId, c]));
    const data = messages.map((m) => {
      const contact = contactBySenderId.get(m.senderId);
      return {
        ...m,
        displayName: contact?.displayName || m.senderName || null,
        username: contact?.username || null,
        avatarUrl: contact?.avatarUrl || null,
      };
    });

    res.json({ data });
  } catch (err) {
    console.error('Messages fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Import recent conversations from the Meta Graph API -------------------
//
// The webhook only captures messages sent AFTER it went live. This pulls the
// most recent conversations per platform (Messenger Conversations API /
// Instagram Messaging API) and backfills inbound customer messages into the
// Message table. Message ids and sender ids are identical to what the webhook
// stores (verified live), so re-imports and webhook overlap dedupe cleanly on
// the messageId unique constraint.

const GRAPH_FB = 'https://graph.facebook.com/v21.0';
const GRAPH_IG = 'https://graph.instagram.com/v21.0';
const IMPORT_CONV_LIMIT = 5;   // conversations per platform
const IMPORT_MSGS_PER_CONV = 10;

async function graphGet(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throw new Error(data?.error?.message || `Graph API HTTP ${res.status}`);
  return data;
}

// Our own account id, needed to keep only inbound (customer) messages.
// Webhook payloads carry it as recipient.id — the most reliable source, since
// FB blocks GET /me for this token (pages_read_engagement not granted).
async function ownIdFromWebhookHistory(platform) {
  const recent = await prisma.message.findFirst({
    where: { platform, rawJson: { contains: '"recipient"' } },
    orderBy: { createdAt: 'desc' },
  });
  if (!recent) return null;
  try { return String(JSON.parse(recent.rawJson)?.recipient?.id || '') || null; } catch { return null; }
}

// Fallback for Facebook: the page is the one participant present in EVERY
// conversation (needs at least 2 conversations to be unambiguous).
function ownIdFromParticipants(conversations) {
  const lists = conversations
    .map((c) => (c.participants?.data || []).map((p) => String(p.id)))
    .filter((l) => l.length);
  if (lists.length < 2) return null;
  const common = lists.reduce((a, b) => a.filter((id) => b.includes(id)));
  return common.length === 1 ? common[0] : null;
}

async function importPlatform(platform) {
  const isIG = platform === 'instagram';
  const token = isIG ? process.env.META_IG_ACCESS_TOKEN : process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return { error: `${isIG ? 'META_IG_ACCESS_TOKEN' : 'META_PAGE_ACCESS_TOKEN'} not set` };

  const base = isIG ? GRAPH_IG : GRAPH_FB;
  const stats = { conversations: 0, imported: 0, skipped: 0 };

  const ownIds = new Set();
  let ownUsername = null;
  const historic = await ownIdFromWebhookHistory(platform);
  if (historic) ownIds.add(historic);
  if (isIG) {
    // graph.instagram.com allows /me — gives username, the most stable own-marker
    const me = await graphGet(`${base}/me?fields=id,username&access_token=${token}`);
    if (me.id) ownIds.add(String(me.id));
    ownUsername = me.username || null;
  }

  const convFields = isIG ? '' : '&fields=participants';
  const convs = await graphGet(`${base}/me/conversations?limit=${IMPORT_CONV_LIMIT}${convFields}&access_token=${token}`);
  const list = convs.data || [];
  if (!isIG) {
    const fromParticipants = ownIdFromParticipants(list);
    if (fromParticipants) ownIds.add(fromParticipants);
  }
  if (!ownIds.size && !ownUsername) {
    return { ...stats, error: 'Could not determine our own account id — import would mix in outbound replies. Message the page once (so the webhook stores a payload) and retry.' };
  }

  for (const conv of list) {
    stats.conversations++;
    const detail = await graphGet(
      `${base}/${conv.id}?fields=messages.limit(${IMPORT_MSGS_PER_CONV})%7Bid,message,from,created_time%7D&access_token=${token}`,
    );
    for (const m of detail.messages?.data || []) {
      const fromId = m.from?.id ? String(m.from.id) : null;
      const fromUsername = m.from?.username || null;
      const isOwn = (fromId && ownIds.has(fromId)) || (ownUsername && fromUsername === ownUsername);
      if (isOwn || !m.id || !fromId || !m.message) continue;

      try {
        await prisma.message.create({
          data: {
            platform,
            messageId: m.id,
            senderId: fromId,
            senderName: m.from?.name || fromUsername || null,
            text: m.message,
            timestamp: new Date(m.created_time),
            rawJson: JSON.stringify({ importedVia: 'graph-conversations', message: m }),
          },
        });
        stats.imported++;
      } catch (err) {
        if (err.code === 'P2002') { stats.skipped++; continue; } // already stored (webhook or prior import)
        throw err;
      }

      // Keep the IG @handle on the contact record (never clobbers a staff-set
      // displayName — update only touches username).
      if (isIG && fromUsername) {
        await prisma.messageContact.upsert({
          where: { platform_senderId: { platform, senderId: fromId } },
          create: { platform, senderId: fromId, username: fromUsername },
          update: { username: fromUsername },
        });
      }
    }
  }
  return stats;
}

// POST /api/messages/import-recent — pull the latest conversations from both
// platforms. Each platform fails independently (a dead IG token must not
// block a Facebook import).
router.post('/import-recent', async (_req, res) => {
  const out = {};
  for (const platform of ['instagram', 'facebook']) {
    try {
      out[platform] = await importPlatform(platform);
    } catch (err) {
      console.error(`[import-recent] ${platform} failed:`, err.message);
      out[platform] = { error: err.message };
    }
  }
  res.json(out);
});

// PATCH /api/messages/contact — staff-set display name override for a sender.
// Needed because Facebook Messenger's real name/photo lookup is gated behind
// pages_messaging App Review, so raw PSIDs are all we get until that clears.
router.patch('/contact', async (req, res) => {
  const { platform, senderId, displayName } = req.body || {};
  if (!platform || !['instagram', 'facebook'].includes(platform) || !senderId || !displayName) {
    return res.status(400).json({ error: 'platform, senderId, and displayName are required' });
  }

  try {
    const contact = await prisma.messageContact.upsert({
      where: { platform_senderId: { platform, senderId } },
      create: { platform, senderId, displayName },
      update: { displayName },
    });
    res.json({ data: contact });
  } catch (err) {
    console.error('Contact update error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
