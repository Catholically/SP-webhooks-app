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
 * Send an alert for unsupported country (not USA or EU)
 * @param orderName - Order name
 * @param orderNumber - Order number
 * @param countryCode - Country code
 * @param countryName - Country name
 * @param tracking - Tracking number
 * @param driveUrl - Google Drive URL for customs doc
 */
export async function sendUnsupportedCountryAlert(
  orderName: string,
  orderNumber: string,
  countryCode: string,
  countryName: string,
  tracking?: string,
  driveUrl?: string
): Promise<void> {
  const alertEmail = process.env.ALERT_EMAIL;

  if (!alertEmail) {
    console.error('[Email Alert] ALERT_EMAIL not configured');
    return;
  }

  const resend = getResendClient();
  if (!resend) {
    return;
  }

  const subject = `⚠️ Manual Label Required - Order ${orderName} (${countryName})`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #ff9800; color: white; padding: 15px; border-radius: 5px; }
          .content { background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin-top: 20px; }
          .warning-box { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
          .info { margin: 10px 0; }
          .label { font-weight: bold; }
          .action-box { background-color: #e3f2fd; border-left: 4px solid #2196f3; padding: 15px; margin: 15px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>⚠️ Manual Label Creation Required</h2>
          </div>
          <div class="content">
            <div class="warning-box">
              <p><strong>Country not supported for automatic label creation:</strong></p>
              <p><strong>${countryName} (${countryCode})</strong></p>
              <p>You do not prepay customs duties for this country.</p>
            </div>

            <h3>Order Information:</h3>
            <div class="info">
              <p><span class="label">Order Name:</span> ${orderName}</p>
              <p><span class="label">Order Number:</span> ${orderNumber}</p>
              <p><span class="label">Destination:</span> ${countryName} (${countryCode})</p>
              ${tracking ? `<p><span class="label">Tracking:</span> ${tracking}</p>` : ''}
            </div>

            <div class="action-box">
              <h3>📋 Action Required:</h3>
              <ol>
                <li><strong>Create label manually</strong> using your alternative shipping tool</li>
                <li><strong>Add tracking number</strong> to the Shopify order</li>
                <li><strong>Add tag</strong> <code>RM-DOG</code> or <code>MI-DOG</code> to generate customs declaration</li>
              </ol>
            </div>

            ${driveUrl ? `
            <div class="info">
              <p><span class="label">✅ Customs Declaration:</span></p>
              <p><a href="${driveUrl}" style="color: #2196f3; text-decoration: none;">📄 View Customs Document on Google Drive</a></p>
              <p style="font-size: 12px; color: #666;">The customs declaration has been pre-generated for your convenience.</p>
            </div>
            ` : ''}

            <p style="margin-top: 20px; color: #666; font-size: 14px;">
              <strong>Note:</strong> Orders are auto-processed only for USA (prepaid customs) and EU (no customs required).
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  try {
    const result = await resend.emails.send({
      from: 'Shipping Alerts <onboarding@resend.dev>',
      to: alertEmail,
      subject: subject,
      html: htmlContent,
    });

    console.log(`[Email Alert] Sent unsupported country alert for order ${orderName}:`, result);
  } catch (emailError) {
    console.error('[Email Alert] Failed to send email:', emailError);
  }
}

/**
 * Send an alert when MI-CREATE or RM-CREATE tag is used on unsupported country
 * @param orderName - Order name
 * @param orderNumber - Order number
 * @param countryCode - Country code
 * @param countryName - Country name
 * @param tag - The tag that was added (MI-CREATE or RM-CREATE)
 */
export async function sendWrongLabelTagAlert(
  orderName: string,
  orderNumber: string,
  countryCode: string,
  countryName: string,
  tag: string
): Promise<void> {
  const alertEmail = process.env.ALERT_EMAIL;

  if (!alertEmail) {
    console.error('[Email Alert] ALERT_EMAIL not configured');
    return;
  }

  const resend = getResendClient();
  if (!resend) {
    return;
  }

  const subject = `🚨 Wrong Tag Used - Order ${orderName} (${countryName})`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #dc3545; color: white; padding: 15px; border-radius: 5px; }
          .content { background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin-top: 20px; }
          .error-box { background-color: #f8d7da; border-left: 4px solid #dc3545; padding: 15px; margin: 15px 0; }
          .info { margin: 10px 0; }
          .label { font-weight: bold; }
          .action-box { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
          .tag { background-color: #e9ecef; padding: 3px 8px; border-radius: 3px; font-family: monospace; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🚨 Wrong Tag Used - Order Not Processed</h2>
          </div>
          <div class="content">
            <div class="error-box">
              <p><strong>⚠️ You cannot use <span class="tag">${tag}</span> for this country!</strong></p>
              <p>Order destination: <strong>${countryName} (${countryCode})</strong></p>
              <p>This country is not USA or EU. You do not prepay customs duties.</p>
            </div>

            <h3>Order Information:</h3>
            <div class="info">
              <p><span class="label">Order Name:</span> ${orderName}</p>
              <p><span class="label">Order Number:</span> ${orderNumber}</p>
              <p><span class="label">Destination:</span> ${countryName} (${countryCode})</p>
              <p><span class="label">Tag Added:</span> <span class="tag">${tag}</span></p>
            </div>

            <div class="action-box">
              <h3>🛠️ What to do:</h3>
              <ol>
                <li><strong>Remove the <span class="tag">${tag}</span> tag</strong> from this order</li>
                <li><strong>Create the shipping label manually</strong> using your alternative tool</li>
                <li><strong>Add the tracking number</strong> to the Shopify order</li>
                <li><strong>Add tag <span class="tag">RM-DOG</span> or <span class="tag">MI-DOG</span></strong> to generate only the customs declaration</li>
              </ol>
            </div>

            <p style="margin-top: 20px; color: #666; font-size: 14px;">
              <strong>Remember:</strong>
              <ul>
                <li><span class="tag">MI-CREATE</span> / <span class="tag">RM-CREATE</span> = Auto-create label (USA/EU only)</li>
                <li><span class="tag">MI-DOG</span> / <span class="tag">RM-DOG</span> = Generate customs only (manual label)</li>
              </ul>
            </p>

            <p style="margin-top: 20px; background-color: #e3f2fd; padding: 10px; border-radius: 5px;">
              <strong>No action was taken.</strong> The order has not been processed by SpedirePro.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  try {
    const result = await resend.emails.send({
      from: 'Shipping Alerts <onboarding@resend.dev>',
      to: alertEmail,
      subject: subject,
      html: htmlContent,
    });

    console.log(`[Email Alert] Sent wrong tag alert for order ${orderName}:`, result);
  } catch (emailError) {
    console.error('[Email Alert] Failed to send email:', emailError);
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
