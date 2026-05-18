'use strict';
const express          = require('express');
const { Webhook }      = require('svix');
const { Resend }       = require('resend');
const { simpleParser } = require('mailparser');
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
    } catch {
      console.warn('[support/inbound] Invalid webhook signature');
      return res.status(200).json({ success: false, message: 'Invalid signature' });
    }

    const event = JSON.parse(body);

    // ── 2. Only handle inbound emails ────────────────────────────────
    if (event.type !== 'email.received') {
      return res.json({ success: true, message: 'Event ignored' });
    }

    const emailId = event.data?.email_id;
    if (!emailId) {
      console.warn('[support/inbound] No email_id in payload');
      return res.json({ success: false, message: 'No email_id' });
    }

    // ── 3. Fetch received email via Resend receiving API ─────────────
    const { data: email, error: fetchError } = await resend.emails.receiving.get(emailId);
    if (fetchError || !email) {
      console.error('[support/inbound] Fetch failed:', fetchError);
      return res.status(200).json({ success: false, message: 'Could not fetch email' });
    }

    const from    = event.data.from || 'unknown@unknown.com';
    const subject = email.subject   || '(no subject)';
    const to      = Array.isArray(event.data.to)
      ? event.data.to[0]
      : (event.data.to || 'support@taskroom.in');

    // ── 4. Parse raw MIME → body + attachments ───────────────────────
    let html        = email.html || null;
    let text        = email.text || null;
    let attachments = [];

    if (email?.raw?.download_url) {
      try {
        const rawContent = await fetch(email.raw.download_url).then(r => r.text());
        const parsed     = await simpleParser(rawContent, { skipImageLinks: true });

        html = parsed.html || html;
        text = parsed.text || text;
        attachments = (parsed.attachments || []).map(att => ({
          filename:     att.filename,
          content:      att.content.toString('base64'),
          content_type: att.contentType,
          content_id:   att.contentId?.replace(/^<|>$/g, '') || undefined,
        }));

        console.log(`[support/inbound] from=${from} html=${!!html} text=${!!text} attachments=${attachments.length}`);
      } catch (parseErr) {
        console.warn('[support/inbound] MIME parse failed:', parseErr.message);
      }
    }

    // ── 5. Forward ───────────────────────────────────────────────────
    await forwardInboundEmail({ from, subject, html, text, to, attachments });

    res.json({ success: true, message: 'Forwarded' });

  } catch (err) {
    console.error('[support/inbound] error:', err.message);
    res.status(200).json({ success: false, message: err.message });
  }
});

module.exports = router;