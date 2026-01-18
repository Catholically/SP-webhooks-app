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
 * @param recipient - Email address to send the label to (default: denticristina@gmail.com)
 * @returns Success status
 */
export async function sendLabelEmail(
  orderName: string,
  labelUrl: string,
  shippingAddress?: ShippingAddress,
  recipient: string = 'denticristina@gmail.com'
): Promise<boolean> {
  const resend = getResendClient();
  if (!resend) {
    console.error('[Email Label] Resend not configured, skipping label email');
    return false;
  }

  const sender = 'noreply@resend.catholically.com'; // Verified domain

  try {
    console.log(`[Email Label] Downloading PDF from Google Drive: ${labelUrl}`);

    // Download PDF from Google Drive
    // Convert Google Drive view URL to direct download URL
    const fileIdMatch = labelUrl.match(/\/d\/([^\/]+)/);
    if (!fileIdMatch) {
      throw new Error('Invalid Google Drive URL format');
    }
    const fileId = fileIdMatch[1];
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuffer);
    console.log(`[Email Label] Downloaded PDF: ${pdfBuffer.length} bytes`);

    // Send email with PDF attachment
    console.log(`[Email Label] Sending label email for order ${orderName} to ${recipient}`);

    // Build email HTML based on whether shipping address is provided
    const emailHtml = shippingAddress ? `
      <p>Ciao,</p>
      <p>Ecco l'etichetta richiesta per l'ordine <strong>${orderName}</strong></p>

      <h3>Dati Spedizione:</h3>
      <p>
        <strong>${shippingAddress.name || 'N/A'}</strong><br>
        ${shippingAddress.address1 || ''}<br>
        ${shippingAddress.address2 ? shippingAddress.address2 + '<br>' : ''}
        ${shippingAddress.zip || ''} ${shippingAddress.city || ''}<br>
        ${shippingAddress.province_code || ''} - ${shippingAddress.country_code || ''}
      </p>

      <p>L'etichetta è allegata a questa email in formato PDF.</p>
    ` : `
      <h2>Shipping Label for Order ${orderName}</h2>
      <p>The shipping label is attached to this email as a PDF file.</p>
      <p>Please find the label attached and print it for shipping.</p>
    `;

    const result = await resend.emails.send({
      from: `Holy Trove <${sender}>`,
      to: recipient,
      subject: orderName,
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
