'use strict';
const express     = require('express');
const { Webhook } = require('svix');
const { forwardInboundEmail } = require('../utils/mailer');

const router = express.Router();

router.post('/inbound', async (req, res) => {
  try {

    // ── 1. Verify webhook signature ──────────────────────────────────
    const wh   = new Webhook(process.env.RESEND_WEBHOOK_SECRET);
    const body = req.body.toString();

    try {
      wh.verify(body, {
        'svix-id':        req.headers['svix-id'],
        'svix-timestamp': req.headers['svix-timestamp'],
        'svix-signature': req.headers['svix-signature'],
      });
    } catch (err) {
      console.warn('[support/inbound] Invalid webhook signature');
      return res.status(200).json({ success: false, message: 'Invalid signature' });
    }

    const event = JSON.parse(body);

    // ── 2. Only handle inbound emails ────────────────────────────────
    if (event.type !== 'email.received') {
      return res.json({ success: true, message: 'Event ignored' });
    }

    const mail = event.data || {};

    const from    = mail.from    || 'unknown@unknown.com';
    const subject = mail.subject || '(no subject)';
    const to      = Array.isArray(mail.to) ? mail.to[0] : (mail.to || 'support@taskroom.in');

    // ── 3. Body is already in the webhook payload ────────────────────
    // resend.emails.get() only works for SENT emails, not inbound ones.
    // The email.received event includes html/text directly in event.data.
    const html = mail.html || null;
    const text = mail.text || null;

    console.log(`[support/inbound] from=${from} subject="${subject}" html=${!!html} text=${!!text}`);

    // ── 4. Forward to Gmail ──────────────────────────────────────────
    await forwardInboundEmail({ from, subject, html, text, to });

    res.json({ success: true, message: 'Forwarded' });

  } catch (err) {
    console.error('[support/inbound] error:', err.message);
    res.status(200).json({ success: false, message: err.message });
  }
});

module.exports = router;