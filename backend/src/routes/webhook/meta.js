'use strict';

// Unified webhook for Meta's Messenger Platform — handles both Facebook
// Messenger (object: "page") and Instagram DMs (object: "instagram"). Meta
// pushes messages to this endpoint; there is no pull/re-fetch API like Gmail
// has, so every inbound message must be persisted here on arrival.

const crypto = require('crypto');
const { Router } = require('express');

const router = Router();
const prisma = require('../../lib/prisma');
const { upsertClientFromMessage } = require('../../lib/agent/classifier');

// Rejects any POST whose X-Hub-Signature-256 doesn't match an HMAC-SHA256 of
// the raw body — proves the request actually came from Meta, not a spoofed
// client hitting our public webhook URL. Messenger ("page") and the
// standalone Instagram API product sign with two DIFFERENT app secrets even
// though they share this one callback URL, so the secret must be picked
// based on the payload's `object` field.
function verifyMetaSignature(req, res, next) {
  const isInstagram = req.body?.object === 'instagram';
  const secret = isInstagram ? process.env.META_IG_APP_SECRET : process.env.META_APP_SECRET;
  if (!secret) {
    const varName = isInstagram ? 'META_IG_APP_SECRET' : 'META_APP_SECRET';
    console.error(`[meta-webhook] ${varName} not set — rejecting (cannot verify signature)`);
    return res.sendStatus(401);
  }

  const header = req.get('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');

  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  if (headerBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(headerBuf, expectedBuf)) {
    return res.sendStatus(401);
  }
  next();
}

// GET /api/webhook/meta — Meta's one-time subscription verification.
router.get('/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Resolves a display name + avatar for a sender via the Graph API.
// Best-effort: on any failure (missing/invalid token, network error,
// unapproved app) this returns nulls so the caller falls back to showing the
// raw sender ID rather than failing the whole webhook. Facebook Messenger's
// name/profile_pic fields are gated behind pages_messaging App Review — this
// will return null name/avatar for Facebook until that's approved — while
// Instagram's standalone messaging product returns both without review.
async function resolveSenderProfile(platform, senderId) {
  const isInstagram = platform === 'instagram';
  const token = isInstagram ? process.env.META_IG_ACCESS_TOKEN : process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return { name: null, username: null, avatarUrl: null };

  const host = isInstagram ? 'graph.instagram.com' : 'graph.facebook.com';
  const fields = isInstagram ? 'name,username,profile_pic' : 'name,profile_pic';
  const url = `https://${host}/v21.0/${senderId}?fields=${fields}&access_token=${token}`;

  try {
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      return {
        name: data.name || data.username || null,
        username: data.username || null,
        avatarUrl: data.profile_pic || null,
      };
    }
  } catch (err) {
    console.error(`[meta-webhook] sender profile lookup failed for ${senderId}:`, err.message);
  }

  // Facebook fallback: the User Profile API above is gated behind
  // pages_messaging App Review, but the Page Conversations API returns
  // participant names with the plain page token — so real names work today;
  // profile photos stay unavailable until review clears (Graph drops the
  // nested picture field silently).
  if (!isInstagram) {
    const name = await resolveFacebookNameViaConversations(senderId, token);
    if (name) return { name, username: null, avatarUrl: null };
  }
  return { name: null, username: null, avatarUrl: null };
}

async function resolveFacebookNameViaConversations(senderId, token) {
  try {
    const url = `https://graph.facebook.com/v21.0/me/conversations?user_id=${encodeURIComponent(senderId)}&fields=participants&access_token=${token}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const participants = data?.data?.[0]?.participants?.data || [];
    return participants.find((p) => p.id === senderId)?.name || null;
  } catch (err) {
    console.error(`[meta-webhook] conversations name lookup failed for ${senderId}:`, err.message);
    return null;
  }
}

// POST /api/webhook/meta — inbound message events.
//
// Processing happens BEFORE the response is sent (unlike a long-running
// server, a serverless function can freeze/terminate the instant the
// response flushes, so anything scheduled "after" res.sendStatus() is not
// guaranteed to run — it would silently drop messages on Vercel). Each
// event is one Graph API call + one DB insert, well within Meta's webhook
// timeout, so there's no throughput reason to defer this either.
router.post('/meta', verifyMetaSignature, async (req, res) => {
  const body = req.body || {};
  const platform = body.object === 'instagram' ? 'instagram' : 'facebook';
  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      try {
        // Skip echoes (messages we sent ourselves) and non-message events
        // (delivery/read receipts, postbacks) — nothing to display yet.
        if (!event.message || event.message.is_echo) continue;
        const text = event.message.text;
        const messageId = event.message.mid;
        const senderId = event.sender?.id;
        if (!messageId || !senderId) continue;

        const { name: senderName, username, avatarUrl } = await resolveSenderProfile(platform, senderId);

        await prisma.message.create({
          data: {
            platform,
            messageId,
            senderId,
            senderName,
            text: text || null,
            timestamp: new Date(event.timestamp || Date.now()),
            rawJson: JSON.stringify(event),
          },
        });

        // Only store fields Graph API actually returned — never clobber a
        // staff-set displayName or a previously resolved value with null, and
        // don't create an empty contact row when nothing resolved.
        if (avatarUrl || username) {
          const resolved = {
            ...(avatarUrl ? { avatarUrl } : {}),
            ...(username ? { username } : {}),
          };
          await prisma.messageContact.upsert({
            where: { platform_senderId: { platform, senderId } },
            create: { platform, senderId, ...resolved },
            update: resolved,
          });
        }

        // Auto-triage into the Clients section: classify the message with the
        // LLM (event enquiry / collaboration / job / general) and create or
        // update the sender's Client record. Runs before the response is sent
        // (serverless — see note above) and never throws, so a classifier
        // hiccup can't make Meta consider the delivery failed.
        await upsertClientFromMessage({
          source: platform,
          channelUserId: senderId,
          senderName,
          text: text || '',
          timestamp: new Date(event.timestamp || Date.now()),
        });
      } catch (err) {
        // Unique constraint violation = Meta redelivered a message we already
        // have; that's expected and not an error.
        if (err.code === 'P2002') continue;
        console.error('[meta-webhook] failed to store message:', err);
      }
    }
  }

  res.sendStatus(200);
});

module.exports = router;
