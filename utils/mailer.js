'use strict';
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Send a payment receipt after successful upgrade.
 */
async function sendPaymentReceipt({ to, orgName, plan, billingCycle, amountINR, validUntil, paymentId }) {
  const formatter  = new Intl.NumberFormat('en-IN');
  const planLabel  = plan.charAt(0).toUpperCase() + plan.slice(1);
  const cycleLabel = billingCycle === 'annual' ? 'Annual' : 'Monthly';
  const validDate  = new Date(validUntil).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  await resend.emails.send({
    from:    process.env.RESEND_FROM,
    to,
    subject: `Payment Receipt — ${planLabel} Plan (TaskRoom)`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: sans-serif; background: #f5f5f5; padding: 32px;">
        <div style="max-width: 520px; margin: 0 auto; background: white;
                    border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <div style="background: #137fec; padding: 28px 32px;">
            <h1 style="color: white; margin: 0; font-size: 22px;">TaskRoom</h1>
            <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0; font-size: 14px;">
              Payment Confirmed ✓
            </p>
          </div>

          <!-- Body -->
          <div style="padding: 32px;">
            <p style="color: #333; font-size: 15px; margin: 0 0 24px;">
              Hi <strong>${orgName}</strong>, your payment was successful.
            </p>

            <!-- Receipt table -->
            <table width="100%" style="border-collapse: collapse; font-size: 14px;">
              <tr style="border-bottom: 1px solid #f0f0f0;">
                <td style="padding: 12px 0; color: #888;">Plan</td>
                <td style="padding: 12px 0; color: #222; text-align: right; font-weight: 600;">
                  ${planLabel}
                </td>
              </tr>
              <tr style="border-bottom: 1px solid #f0f0f0;">
                <td style="padding: 12px 0; color: #888;">Billing Cycle</td>
                <td style="padding: 12px 0; color: #222; text-align: right;">
                  ${cycleLabel}
                </td>
              </tr>
              <tr style="border-bottom: 1px solid #f0f0f0;">
                <td style="padding: 12px 0; color: #888;">Valid Until</td>
                <td style="padding: 12px 0; color: #222; text-align: right;">
                  ${validDate}
                </td>
              </tr>
              <tr style="border-bottom: 1px solid #f0f0f0;">
                <td style="padding: 12px 0; color: #888;">Payment ID</td>
                <td style="padding: 12px 0; color: #888; text-align: right; font-size: 12px;">
                  ${paymentId}
                </td>
              </tr>
              <tr>
                <td style="padding: 16px 0 0; color: #333; font-weight: 700; font-size: 16px;">
                  Total Paid
                </td>
                <td style="padding: 16px 0 0; color: #137fec; font-weight: 700;
                           font-size: 18px; text-align: right;">
                  ₹${formatter.format(amountINR)}
                </td>
              </tr>
            </table>

            <div style="margin-top: 28px; padding: 16px; background: #f0f7ff;
                        border-radius: 8px; font-size: 13px; color: #555;">
              Questions? Reply to this email or contact
              <a href="mailto:support@taskroom.in" style="color: #137fec;">
                support@taskroom.in
              </a>
            </div>
          </div>

          <!-- Footer -->
          <div style="padding: 20px 32px; background: #fafafa;
                      border-top: 1px solid #f0f0f0; font-size: 12px; color: #aaa;">
            TaskRoom · This is an automated receipt, please do not reply directly.
          </div>
        </div>
      </body>
      </html>
    `,
  });
}

module.exports = { sendPaymentReceipt };