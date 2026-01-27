import { getResendClient } from './email-alerts';

/**
 * Shipping address for email body
 */
type ShippingAddress = {
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  zip?: string;
  province_code?: string;
  country_code?: string;
};

/**
 * Send shipping label email with PDF attachment
 * @param orderName - Order name/ID (e.g., #35622182025)
 * @param labelUrl - Google Drive URL to the shipping label PDF
 * @param shippingAddress - Optional shipping address to include in email body
 * @param recipient - Email address to send the label to (default: denti.cristina@gmail.com)
 * @returns Success status
 */
export async function sendLabelEmail(
  orderName: string,
  labelUrl: string,
  shippingAddress?: ShippingAddress,
  recipient: string = 'denti.cristina@gmail.com'
): Promise<boolean> {
  const resend = getResendClient();
  if (!resend) {
    console.error('[Email Label] Resend not configured, skipping label email');
    return false;
  }

  const sender = 'noreply@resend.catholically.com'; // Verified domain

  try {
    console.log(`[Email Label] Downloading PDF from: ${labelUrl}`);

    // Determine download URL based on source
    let downloadUrl: string;

    if (labelUrl.includes('drive.google.com')) {
      // Google Drive URL - convert to direct download
      const fileIdMatch = labelUrl.match(/\/d\/([^\/]+)/);
      if (!fileIdMatch) {
        throw new Error('Invalid Google Drive URL format');
      }
      const fileId = fileIdMatch[1];
      downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
      console.log(`[Email Label] Google Drive detected, download URL: ${downloadUrl}`);
    } else {
      // Direct URL (Easyship or other) - use as-is
      downloadUrl = labelUrl;
      console.log(`[Email Label] Direct URL detected, using as-is`);
    }

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuffer);
    console.log(`[Email Label] Downloaded PDF: ${pdfBuffer.length} bytes`);

    // Send email with PDF attachment
    console.log(`[Email Label] Sending label email for order ${orderName} to ${recipient}`);

    // Build email subject with order name and recipient name
    const recipientName = shippingAddress?.name || '';
    const emailSubject = recipientName
      ? `${orderName} - ${recipientName}`
      : orderName;

    // Build beautiful email HTML
    const emailHtml = shippingAddress ? `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: Arial, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px 0;">
          <tr>
            <td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

                <!-- Header -->
                <tr>
                  <td style="background: linear-gradient(135deg, #2c5282 0%, #1a365d 100%); padding: 25px 30px; text-align: center;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: bold;">📦 Etichetta Spedizione</h1>
                  </td>
                </tr>

                <!-- Order Info -->
                <tr>
                  <td style="padding: 30px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #ebf8ff; border-radius: 8px; border-left: 4px solid #3182ce;">
                      <tr>
                        <td style="padding: 20px;">
                          <p style="margin: 0 0 5px 0; color: #2c5282; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Ordine</p>
                          <p style="margin: 0; color: #1a365d; font-size: 28px; font-weight: bold;">${orderName}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Shipping Address -->
                <tr>
                  <td style="padding: 0 30px 30px 30px;">
                    <h2 style="margin: 0 0 15px 0; color: #2d3748; font-size: 18px; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">📍 Indirizzo di Spedizione</h2>
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f7fafc; border-radius: 8px;">
                      <tr>
                        <td style="padding: 20px;">
                          <p style="margin: 0 0 8px 0; color: #1a365d; font-size: 20px; font-weight: bold;">${shippingAddress.name || 'N/A'}</p>
                          <p style="margin: 0; color: #4a5568; font-size: 16px; line-height: 1.6;">
                            ${shippingAddress.address1 || ''}<br>
                            ${shippingAddress.address2 ? shippingAddress.address2 + '<br>' : ''}
                            ${shippingAddress.zip || ''} ${shippingAddress.city || ''}<br>
                            <strong>${shippingAddress.province_code || ''} - ${shippingAddress.country_code || ''}</strong>
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Attachment Notice -->
                <tr>
                  <td style="padding: 0 30px 30px 30px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #c6f6d5; border-radius: 8px; border-left: 4px solid #38a169;">
                      <tr>
                        <td style="padding: 15px 20px;">
                          <p style="margin: 0; color: #276749; font-size: 16px;">
                            ✅ <strong>L'etichetta PDF è allegata a questa email.</strong>
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td style="background-color: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0; color: #718096; font-size: 12px;">Holy Trove / Catholically - Magazzino Milano</p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    ` : `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="margin: 0; padding: 20px; background-color: #f5f5f5; font-family: Arial, sans-serif;">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; padding: 30px;">
          <tr>
            <td>
              <h2 style="color: #2c5282; margin: 0 0 20px 0;">📦 Shipping Label - ${orderName}</h2>
              <p style="color: #4a5568; font-size: 16px;">The shipping label is attached to this email as a PDF file.</p>
              <p style="color: #38a169; font-size: 14px; background-color: #c6f6d5; padding: 10px; border-radius: 4px;">✅ Please find the label attached and print it for shipping.</p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const result = await resend.emails.send({
      from: `Etichetta Easyship <${sender}>`,
      to: recipient,
      subject: emailSubject,
      html: emailHtml,
      attachments: [
        {
          filename: `${orderName.replace('#', '')}_label.pdf`,
          content: pdfBuffer,
        },
      ],
    });

    if (result.error) {
      console.error('[Email Label] Failed to send label email:', result.error);
      return false;
    }

    console.log(`[Email Label] ✅ Label email sent successfully for order ${orderName} with PDF attachment`);
    return true;
  } catch (error) {
    console.error('[Email Label] Error sending label email:', error);
    return false;
  }
}

// Re-export getResendClient for convenience
export { getResendClient };
