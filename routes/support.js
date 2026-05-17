'use strict';
const express = require('express');
const crypto  = require('crypto');
const { forwardInboundEmail } = require('../utils/mailer');

const router = express.Router();

// ── POST /api/support/inbound  (Resend webhook) ───────────────────────
router.post('/inbound', async (req, res) => {
  try {

    // ── 1. Verify webhook signature ──────────────────────────────────
    // Svix secrets are base64 after the "whsec_" prefix
    const rawSecret = process.env.RESEND_WEBHOOK_SECRET || '';
    const secret = rawSecret.startsWith('whsec_')
    ? Buffer.from(rawSecret.replace('whsec_', ''), 'base64')
    : rawSecret;

    if (secret) {
      const signature = req.headers['svix-signature']
                     || req.headers['resend-signature']
                     || '';
      const msgId        = req.headers['svix-id'] || '';
      const msgTimestamp = req.headers['svix-timestamp'] || '';
      const payload      = `${msgId}.${msgTimestamp}.${JSON.stringify(req.body)}`;

      const expected = crypto
        .createHmac('sha256', secret)   // secret is now a Buffer ✅
        .update(payload)
        .digest('hex');

      // Resend uses svix — signature is comma-separated list of "v1,<hash>"
      const sigValid = signature
        .split(' ')
        .some(s => s.replace(/^v1,/, '') === expected);

      if (!sigValid) {
        console.warn('[support/inbound] Invalid webhook signature');
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }
    }

    // ── 2. Parse the inbound email event ────────────────────────────
    const event = req.body;

    // Resend wraps it as { type: 'email.received', data: { ... } }
    if (event.type !== 'email.received') {
      return res.json({ success: true, message: 'Event ignored' });
    }

    const mail = event.data || event;

    const from    = mail.from    || mail.sender || 'unknown@unknown.com';
    const subject = mail.subject || '(no subject)';
    const html    = mail.html    || null;
    const text    = mail.text    || mail.plain_text || null;
    const to      = mail.to      || 'support@taskroom.in';

    console.log(`[support/inbound] Email from ${from} — "${subject}"`);

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