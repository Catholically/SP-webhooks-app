import { getResendClient } from './email-alerts';

/**
 * Send shipping label email for MI-CREATE orders with PDF attachment
 * @param orderName - Order name/ID (e.g., #35622182025)
 * @param labelUrl - Google Drive URL to the shipping label PDF
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

    const result = await resend.emails.send({
      from: `Holy Trove <${sender}>`,
      to: recipient,
      subject: orderName,
      html: `
        <h2>Shipping Label for Order ${orderName}</h2>
        <p>The shipping label is attached to this email as a PDF file.</p>
        <p>Please find the label attached and print it for shipping.</p>
      `,
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
