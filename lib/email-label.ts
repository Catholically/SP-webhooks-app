import { getResendClient } from './email-alerts';

/**
 * Send shipping label email for MI-CREATE orders with PDF attachment
 * @param orderName - Order name/ID (e.g., #35622182025)
 * @param labelUrl - Google Drive URL to the shipping label PDF
 * @param recipient - Email address to send the label to (default: denticristina@gmail.com)
 * @param customerName - Customer name (optional)
 * @param tracking - Tracking number (optional)
 * @param courier - Courier/carrier name (optional)
 * @returns Success status
 */
export async function sendLabelEmail(
  orderName: string,
  labelUrl: string,
  recipient: string = 'denticristina@gmail.com',
  customerName?: string,
  tracking?: string,
  courier?: string
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

    const result = await resend.emails.send({
      from: `Holy Trove <${sender}>`,
      to: recipient,
      subject: `Nuova Etichetta di Spedizione - ${orderName}`,
      html: `
        <h2>Nuova Etichetta di Spedizione</h2>

        <p><strong>Order name:</strong> ${orderName}</p>
        ${customerName ? `<p><strong>Customer name:</strong> ${customerName}</p>` : ''}
        ${tracking ? `<p><strong>Tracking Number:</strong> ${tracking}</p>` : ''}
        ${courier ? `<p><strong>Corriere:</strong> ${courier}</p>` : ''}

        <p style="margin-top: 20px;">L'etichetta di spedizione è allegata a questa email in formato PDF.</p>
        <p>Puoi stampare l'etichetta direttamente dall'allegato.</p>
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
