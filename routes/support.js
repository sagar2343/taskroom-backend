'use strict';
const express = require('express');
// const crypto  = require('crypto');
const { Webhook } = require('svix');
const { forwardInboundEmail } = require('../utils/mailer');

const router = express.Router();

// ── POST /api/support/inbound  (Resend webhook) ───────────────────────
router.post('/inbound', async (req, res) => {
  try {

    // ── 1. Verify webhook signature ──────────────────────────────────
    // Svix secrets are base64 after the "whsec_" prefix
    // const rawSecret = process.env.RESEND_WEBHOOK_SECRET || '';
    // const secret = rawSecret.startsWith('whsec_')
    // ? Buffer.from(rawSecret.replace('whsec_', ''), 'base64')
    // : rawSecret;

    // if (secret) {
    //   const signature = req.headers['svix-signature']
    //                  || req.headers['resend-signature']
    //                  || '';
    //   const msgId        = req.headers['svix-id'] || '';
    //   const msgTimestamp = req.headers['svix-timestamp'] || '';
    //   const payload      = `${msgId}.${msgTimestamp}.${JSON.stringify(req.body)}`;

    //   const expected = crypto
    //     .createHmac('sha256', secret)   // secret is now a Buffer ✅
    //     .update(payload)
    //     .digest('hex');

    //   // Resend uses svix — signature is comma-separated list of "v1,<hash>"
    //   const sigValid = signature
    //     .split(' ')
    //     .some(s => s.replace(/^v1,/, '') === expected);

    //   if (!sigValid) {
    //     console.warn('[support/inbound] Invalid webhook signature');
    //     return res.status(400).json({ success: false, message: 'Invalid signature' });
    //   }
    // }

    const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);

    const body = req.body.toString();

    try {
      wh.verify(body, {
        'svix-id': req.headers['svix-id'],
        'svix-timestamp': req.headers['svix-timestamp'],
        'svix-signature': req.headers['svix-signature'],
      });
    } catch (err) {
      console.warn('[support/inbound] Invalid webhook signature');

      return res.status(200).json({
        success: false,
        message: 'Invalid signature',
      });
    }

    const event = JSON.parse(body);

    // ── 2. Parse the inbound email event ────────────────────────────
    // const event = req.body;

    // Resend wraps it as { type: 'email.received', data: { ... } }
    if (event.type !== 'email.received') {
      return res.json({ success: true, message: 'Event ignored' });
    }

    const mail = event.data || event;

  const from    = mail.from    || mail.sender || 'unknown@unknown.com';
  const subject = mail.subject || '(no subject)';
  const to      = Array.isArray(mail.to) ? mail.to[0] : (mail.to || 'support@taskroom.in');

  // ── Extract body from attachments (Resend sends body as MIME parts) ──
  let html = mail.html || null;
  let text = mail.text || null;

  const attachments = mail.attachments || [];
  for (const att of attachments) {
    // Resend encodes body as base64 in attachments with content_type
    const ct = (att.content_type || att.type || '').toLowerCase();
    const content = att.content
      ? Buffer.from(att.content, 'base64').toString('utf8')
      : (att.body || att.data || null);

    if (!html && ct.includes('text/html'))  html = content;
    if (!text && ct.includes('text/plain')) text = content;
  }

  // ── Fallback: fetch full email via Resend API using email_id ─────────
  if (!html && !text && mail.email_id) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const fetched = await resend.emails.get(mail.email_id);

      // Log the FULL raw response so we can see the exact structure
      console.log('[support/inbound] RAW fetched:', JSON.stringify(fetched, null, 2));

      html = fetched?.data?.html || fetched?.html || null;
      text = fetched?.data?.text || fetched?.text || null;
    } catch (fetchErr) {
      console.warn('[support/inbound] Could not fetch email body:', fetchErr.message);
    }
  }

  // Log the full attachment object to see its exact fields
  if (attachments.length > 0) {
    console.log('[support/inbound] RAW attachment[0]:', JSON.stringify(attachments[0], null, 2));
  }

  console.log(`[support/inbound] from=${from} subject="${subject}" html=${!!html} text=${!!text} attachments=${attachments.length}`);

  console.log(`[support/inbound] from=${from} subject="${subject}" html=${!!html} text=${!!text} attachments=${attachments.length}`);

    // ── 3. Forward to your Gmail ─────────────────────────────────────
    await forwardInboundEmail({ from, subject, html, text, to });

    res.json({ success: true, message: 'Forwarded' });

  } catch (err) {
    console.error('[support/inbound] error:', err.message);
    // Always return 200 to Resend so it doesn't retry endlessly
    res.status(200).json({ success: false, message: err.message });
  }
});

module.exports = router;