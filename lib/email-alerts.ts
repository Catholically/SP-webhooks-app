import { Resend } from 'resend';

interface CustomsErrorAlert {
  orderName: string;
  orderNumber: string;
  tracking?: string;
  errorType: string;
  errorDetails: string;
  missingData?: string[];
  timestamp: Date;
}

/**
 * Get Resend client (lazy initialization to avoid build-time errors)
 */
export function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[Email Alert] RESEND_API_KEY not configured');
    return null;
  }
  return new Resend(apiKey);
}

/**
 * Send an error alert email when customs declaration fails
 * @param error - Error details
 */
export async function sendCustomsErrorAlert(error: CustomsErrorAlert): Promise<void> {
  const alertEmail = process.env.ALERT_EMAIL;

  if (!alertEmail) {
    console.error('[Email Alert] ALERT_EMAIL not configured');
    return;
  }

  const resend = getResendClient();
  if (!resend) {
    return;
  }

  const subject = `⚠️ Customs Declaration Error - Order ${error.orderName}`;

  const missingDataSection = error.missingData && error.missingData.length > 0
    ? `
    <h3>Missing Data:</h3>
    <ul>
      ${error.missingData.map(item => `<li>${item}</li>`).join('\n      ')}
    </ul>
    `
    : '';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #ff4444; color: white; padding: 15px; border-radius: 5px; }
          .content { background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin-top: 20px; }
          .error-box { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
          .info { margin: 10px 0; }
          .label { font-weight: bold; }
          ul { margin: 10px 0; }
          li { margin: 5px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>⚠️ Customs Declaration Error</h2>
          </div>
          <div class="content">
            <p>A customs declaration could not be generated due to the following error:</p>

            <div class="error-box">
              <p class="label">Error Type:</p>
              <p>${error.errorType}</p>

              <p class="label">Error Details:</p>
              <p>${error.errorDetails}</p>
            </div>

            <h3>Order Information:</h3>
            <div class="info">
              <p><span class="label">Order Name:</span> ${error.orderName}</p>
              <p><span class="label">Order Number:</span> ${error.orderNumber}</p>
              ${error.tracking ? `<p><span class="label">Tracking:</span> ${error.tracking}</p>` : ''}
              <p><span class="label">Timestamp:</span> ${error.timestamp.toISOString()}</p>
            </div>

            ${missingDataSection}

            <p style="margin-top: 20px;">
              <strong>Action Required:</strong> Please review the order and ensure all required customs data is present, then manually create the customs declaration.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  try {
    const result = await resend.emails.send({
      from: 'Customs Alerts <onboarding@resend.dev>', // Change to your verified domain
      to: alertEmail,
      subject: subject,
      html: htmlContent,
    });

    console.log(`[Email Alert] Sent customs error alert for order ${error.orderName}:`, result);
  } catch (emailError) {
    console.error('[Email Alert] Failed to send email:', emailError);
    // Don't throw - we don't want email failures to break the main process
  }
}

/**
 * Send a success notification email (optional)
 * @param orderName - Order name
 * @param tracking - Tracking number
 * @param driveUrl - Google Drive URL
 */
export async function sendCustomsSuccessNotification(
  orderName: string,
  tracking: string,
  driveUrl: string
): Promise<void> {
  const alertEmail = process.env.ALERT_EMAIL;

  if (!alertEmail) {
    return; // Silently skip if not configured
  }

  const resend = getResendClient();
  if (!resend) {
    return; // Silently skip if not configured
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #28a745; color: white; padding: 15px; border-radius: 5px; }
          .content { background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>✅ Customs Declaration Created</h2>
          </div>
          <div class="content">
            <p><strong>Order:</strong> ${orderName}</p>
            <p><strong>Tracking:</strong> ${tracking}</p>
            <p><strong>Document:</strong> <a href="${driveUrl}">View on Google Drive</a></p>
          </div>
        </div>
      </body>
    </html>
  `;

  try {
    await resend.emails.send({
      from: 'Customs Alerts <onboarding@resend.dev>',
      to: alertEmail,
      subject: `✅ Customs Declaration Created - ${orderName}`,
      html: htmlContent,
    });
  } catch (error) {
    console.error('[Email Alert] Failed to send success notification:', error);
  }
}
