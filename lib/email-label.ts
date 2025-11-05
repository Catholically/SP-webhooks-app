import { getResendClient } from './email-alerts';

/**
 * Send shipping label email for MI-CREATE orders
 * @param orderName - Order name/ID (e.g., #35622182025)
 * @param labelUrl - URL to the shipping label PDF
 * @returns Success status
 */
export async function sendLabelEmail(
  orderName: string,
  labelUrl: string
): Promise<boolean> {
  const resend = getResendClient();
  if (!resend) {
    console.error('[Email Label] Resend not configured, skipping label email');
    return false;
  }

  const recipient = 'denti.cristina@gmail.com';
  const sender = process.env.ALERT_EMAIL || 'robykz@gmail.com';

  try {
    console.log(`[Email Label] Sending label email for order ${orderName} to ${recipient}`);

    const result = await resend.emails.send({
      from: `Holy Trove <${sender}>`,
      to: recipient,
      subject: orderName,
      html: `
        <h2>Shipping Label for Order ${orderName}</h2>
        <p>The shipping label is ready for this order.</p>
        <p><strong><a href="${labelUrl}" target="_blank">Download Shipping Label PDF</a></strong></p>
        <hr>
        <p style="font-size: 12px; color: #666;">
          Direct link: <a href="${labelUrl}">${labelUrl}</a>
        </p>
      `,
    });

    if (result.error) {
      console.error('[Email Label] Failed to send label email:', result.error);
      return false;
    }

    console.log(`[Email Label] ✅ Label email sent successfully for order ${orderName}`);
    return true;
  } catch (error) {
    console.error('[Email Label] Error sending label email:', error);
    return false;
  }
}

// Re-export getResendClient for convenience
export { getResendClient };
