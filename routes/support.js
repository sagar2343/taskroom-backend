'use strict';
const express  = require('express');
const { Webhook } = require('svix');
const { Resend } = require('resend');
const { forwardInboundEmail } = require('../utils/mailer');

const router = express.Router();
const resend  = new Resend(process.env.RESEND_API_KEY);

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

    const mail    = event.data || {};
    const emailId = mail.email_id;
    const from    = mail.from    || 'unknown@unknown.com';
    const subject = mail.subject || '(no subject)';
    const to      = Array.isArray(mail.to) ? mail.to[0] : (mail.to || 'support@taskroom.in');

    console.log(`[support/inbound] Received from=${from} subject="${subject}" email_id=${emailId}`);

    // ── 3. Fetch full email body via Resend API ───────────────────────
    // The email.received webhook never includes html/text — must fetch separately
    let html = null;
    let text = null;

    if (emailId) {
      try {
        const { data: fullEmail, error } = await resend.emails.get(emailId);

        if (error) {
          console.warn('[support/inbound] API error:', error);
        } else {
          console.log('[support/inbound] fullEmail keys:', Object.keys(fullEmail || {}));
          html = fullEmail?.html  || null;
          text = fullEmail?.text  || null;

          // ── Fallback: download raw MIME if html/text still null ────
          if (!html && !text && fullEmail?.raw?.download_url) {
            try {
              const rawRes  = await fetch(fullEmail.raw.download_url);
              const rawMime = await rawRes.text();

              // Extract plain text from raw MIME (simple extraction)
              const textMatch = rawMime.match(
                /Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|\r\n\r\n--)/i
              );
              const htmlMatch = rawMime.match(
                /Content-Type: text\/html[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|\r\n\r\n--)/i
              );

              if (textMatch) text = textMatch[1].trim();
              if (htmlMatch) html = htmlMatch[1].trim();

              console.log(`[support/inbound] Raw MIME parsed: html=${!!html} text=${!!text}`);
            } catch (rawErr) {
              console.warn('[support/inbound] Raw MIME fetch failed:', rawErr.message);
            }
          }
        }
      } catch (fetchErr) {
        console.warn('[support/inbound] Could not fetch email:', fetchErr.message);
      }
    }

    console.log(`[support/inbound] Final: html=${!!html} text=${!!text}`);

    // ── 4. Forward to Gmail ──────────────────────────────────────────
    await forwardInboundEmail({ from, subject, html, text, to });

    res.json({ success: true, message: 'Forwarded' });

  } catch (err) {
    console.error('[support/inbound] error:', err.message);
    res.status(200).json({ success: false, message: err.message });
  }
});

module.exports = router;