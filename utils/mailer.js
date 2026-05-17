'use strict';
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

/* ── SHARED EMAIL WRAPPER ──────────────────────────────────────────── */
async function sendEmail({ to, subject, html, replyTo, fromSupport = false }) {
  const from = fromSupport
    ? (process.env.RESEND_FROM_SUPPORT || 'TaskRoom <support@taskroom.in>')
    : (process.env.RESEND_FROM         || 'TaskRoom Billing <billing@taskroom.in>');

  return resend.emails.send({
    from,
    to,
    subject,
    html,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });
}

/* ── PAYMENT RECEIPT ───────────────────────────────────────────────── */
async function sendPaymentReceipt({
  to, orgName, plan, billingCycle,
  amountINR, validUntil, paymentId,
}) {
  const formatter  = new Intl.NumberFormat('en-IN');
  const planLabel  = plan.charAt(0).toUpperCase() + plan.slice(1);
  const cycleLabel = billingCycle === 'annual' ? 'Annual' : 'Monthly';
  const validDate  = new Date(validUntil).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  await sendEmail({
    to,
    subject: `Payment Receipt — ${planLabel} Plan (TaskRoom)`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Inter,sans-serif;background:#f5f5f5;padding:32px;margin:0">
        <div style="max-width:520px;margin:0 auto;background:#fff;
                    border-radius:12px;overflow:hidden;
                    box-shadow:0 2px 8px rgba(0,0,0,.08)">

          <div style="background:#137fec;padding:28px 32px">
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800">
              TaskRoom
            </h1>
            <p style="color:rgba(255,255,255,.85);margin:6px 0 0;font-size:14px">
              Payment Confirmed ✓
            </p>
          </div>

          <div style="padding:32px">
            <p style="color:#333;font-size:15px;margin:0 0 24px">
              Hi <strong>${orgName}</strong>, your payment was successful.
            </p>

            <table width="100%" style="border-collapse:collapse;font-size:14px">
              <tr style="border-bottom:1px solid #f0f0f0">
                <td style="padding:12px 0;color:#888">Plan</td>
                <td style="padding:12px 0;color:#222;text-align:right;
                           font-weight:600">${planLabel}</td>
              </tr>
              <tr style="border-bottom:1px solid #f0f0f0">
                <td style="padding:12px 0;color:#888">Billing Cycle</td>
                <td style="padding:12px 0;color:#222;
                           text-align:right">${cycleLabel}</td>
              </tr>
              <tr style="border-bottom:1px solid #f0f0f0">
                <td style="padding:12px 0;color:#888">Valid Until</td>
                <td style="padding:12px 0;color:#222;
                           text-align:right">${validDate}</td>
              </tr>
              <tr style="border-bottom:1px solid #f0f0f0">
                <td style="padding:12px 0;color:#888">Payment ID</td>
                <td style="padding:12px 0;color:#aaa;text-align:right;
                           font-size:12px;font-family:monospace">${paymentId}</td>
              </tr>
              <tr>
                <td style="padding:16px 0 0;color:#333;font-weight:700;
                           font-size:16px">Total Paid</td>
                <td style="padding:16px 0 0;color:#137fec;font-weight:700;
                           font-size:18px;text-align:right">
                  ₹${formatter.format(amountINR)}
                </td>
              </tr>
            </table>

            <div style="margin-top:28px;padding:16px;background:#f0f7ff;
                        border-radius:8px;font-size:13px;color:#555">
              Questions? Reply to this email or contact
              <a href="mailto:support@taskroom.in"
                 style="color:#137fec">support@taskroom.in</a>
            </div>
          </div>

          <div style="padding:20px 32px;background:#fafafa;
                      border-top:1px solid #f0f0f0;
                      font-size:12px;color:#aaa">
            © ${new Date().getFullYear()} TaskRoom · 
            <a href="https://taskroom.in" 
               style="color:#aaa;text-decoration:none">taskroom.in</a>
          </div>
        </div>
      </body>
      </html>
    `,
  });
}

/* ── FORWARD INBOUND EMAIL TO GMAIL ────────────────────────────────── */
async function forwardInboundEmail({
  from, subject, text, html, to,
}) {
  const forwardTo = process.env.SUPPORT_FORWARD_TO;
  if (!forwardTo) {
    console.warn('[mailer] SUPPORT_FORWARD_TO not set — skipping forward');
    return;
  }

  await sendEmail({
    to:      forwardTo,
    subject: `[TaskRoom Support] ${subject || '(no subject)'}`,
    replyTo: from,
    fromSupport: true,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Inter,sans-serif;
                   background:#f5f5f5;padding:24px;margin:0">
        <div style="max-width:600px;margin:0 auto;background:#fff;
                    border-radius:12px;overflow:hidden;
                    box-shadow:0 2px 8px rgba(0,0,0,.08)">

          <!-- Banner -->
          <div style="background:#137fec;padding:18px 28px;
                      display:flex;align-items:center;gap:12px">
            <span style="font-size:22px">📩</span>
            <div>
              <div style="color:#fff;font-weight:700;font-size:15px">
                New message to support@taskroom.in
              </div>
              <div style="color:rgba(255,255,255,.75);font-size:12px;
                          margin-top:2px">
                Forwarded by TaskRoom
              </div>
            </div>
          </div>

          <!-- Meta -->
          <div style="padding:20px 28px;background:#f8f9fa;
                      border-bottom:1px solid #eee">
            <table style="font-size:13px;color:#555;
                          border-collapse:collapse;width:100%">
              <tr>
                <td style="padding:4px 0;width:70px;
                           color:#888;font-weight:600">FROM</td>
                <td style="padding:4px 0">
                  <a href="mailto:${from}" 
                     style="color:#137fec">${from}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#888;font-weight:600">TO</td>
                <td style="padding:4px 0;color:#555">${to || 'support@taskroom.in'}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#888;font-weight:600">
                  SUBJECT
                </td>
                <td style="padding:4px 0;color:#222;font-weight:600">
                  ${subject || '(no subject)'}
                </td>
              </tr>
            </table>
          </div>

          <!-- Body -->
          <div style="padding:28px;font-size:14px;color:#333;line-height:1.7">
            ${html
                ? html
                : text
                  ? `<pre style="font-family:inherit;white-space:pre-wrap;word-break:break-word">${text}</pre>`
                  : `<p style="color:#999;font-style:italic">(No body content — sender may have sent a blank email)</p>`
              }
          </div>

          <!-- Reply tip -->
          <div style="padding:16px 28px;background:#fff8e1;
                      border-top:1px solid #ffe082;
                      font-size:12px;color:#888">
            💡 Hit <strong>Reply</strong> in Gmail to respond directly 
            to <strong>${from}</strong>
          </div>

        </div>
      </body>
      </html>
    `,
  });
}

/* ── WELCOME / ONBOARDING EMAIL ────────────────────────────────────── */
async function sendWelcomeEmail({ to, orgName, orgCode, managerName }) {
  await sendEmail({
    to,
    subject: `Welcome to TaskRoom — Your org is ready 🎉`,
    fromSupport: true,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Inter,sans-serif;
                   background:#f5f5f5;padding:32px;margin:0">
        <div style="max-width:520px;margin:0 auto;background:#fff;
                    border-radius:12px;overflow:hidden;
                    box-shadow:0 2px 8px rgba(0,0,0,.08)">

          <div style="background:#137fec;padding:28px 32px">
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800">
              TaskRoom
            </h1>
            <p style="color:rgba(255,255,255,.85);margin:6px 0 0;font-size:14px">
              Your workspace is ready 🎉
            </p>
          </div>

          <div style="padding:32px">
            <p style="font-size:15px;color:#333;margin:0 0 20px">
              Hi <strong>${managerName || orgName}</strong>, welcome to TaskRoom!
            </p>

            <div style="background:#f0f7ff;border:1px solid #cce3fd;
                        border-radius:10px;padding:20px;margin-bottom:24px;
                        text-align:center">
              <div style="font-size:12px;color:#888;
                          text-transform:uppercase;letter-spacing:.08em;
                          margin-bottom:8px">
                Your Organization Code
              </div>
              <div style="font-size:36px;font-weight:900;
                          letter-spacing:6px;color:#137fec;
                          font-family:monospace">
                ${orgCode}
              </div>
              <div style="font-size:12px;color:#888;margin-top:8px">
                Share this with your team to join via the mobile app
              </div>
            </div>

            <table width="100%" style="border-collapse:collapse;
                                       font-size:14px;margin-bottom:24px">
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #f0f0f0">
                  <span style="color:#137fec;margin-right:8px">1️⃣</span>
                  Download the TaskRoom Android app
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #f0f0f0">
                  <span style="color:#137fec;margin-right:8px">2️⃣</span>
                  Share code <strong>${orgCode}</strong> with your team
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0">
                  <span style="color:#137fec;margin-right:8px">3️⃣</span>
                  Create rooms and assign your first task
                </td>
              </tr>
            </table>

            <a href="https://taskroom.in"
               style="display:block;background:#137fec;color:#fff;
                      text-align:center;padding:14px;border-radius:8px;
                      font-weight:700;font-size:15px;text-decoration:none">
              Open Dashboard →
            </a>
          </div>

          <div style="padding:20px 32px;background:#fafafa;
                      border-top:1px solid #f0f0f0;
                      font-size:12px;color:#aaa">
            © ${new Date().getFullYear()} TaskRoom · 
            Questions? 
            <a href="mailto:support@taskroom.in" 
               style="color:#aaa">support@taskroom.in</a>
          </div>
        </div>
      </body>
      </html>
    `,
  });
}

module.exports = {
  sendEmail,
  sendPaymentReceipt,
  forwardInboundEmail,
  sendWelcomeEmail,
};