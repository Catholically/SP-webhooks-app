import { google } from 'googleapis';

type ShippingLogData = {
  orderNumber: string;
  shipmentId: string;
  trackingNumber: string;
  courierName: string;
  shippingCost: number | null;
  labelUrl: string;
};

/**
 * Logga la spedizione su Google Sheets
 * Stesso foglio usato da Easyship webhook
 * Colonne: Data | Order | Shipment ID | Tracking | Corriere | Costo (EUR) | URL
 */
export async function logToGoogleSheets(data: ShippingLogData): Promise<void> {
  // Prova prima con JSON completo (come easyship-webhook), poi fallback a email+key
  const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID?.trim();

  if (!spreadsheetId) {
    console.log('[Google Sheets] GOOGLE_SPREADSHEET_ID not configured, skipping logging');
    return;
  }

  let auth;

  if (credentialsJson) {
    // Metodo 1: JSON completo (compatibile con easyship-webhook)
    try {
      const serviceAccount = JSON.parse(credentialsJson);
      auth = new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
    } catch (err) {
      console.error('[Google Sheets] Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', err);
      return;
    }
  } else if (serviceAccountEmail && privateKey) {
    // Metodo 2: Email + Private Key separati (come google-drive.ts)
    auth = new google.auth.JWT({
      email: serviceAccountEmail,
      key: privateKey.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    console.log('[Google Sheets] No Google credentials configured, skipping logging');
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth });

    // Formatta data italiana (solo giorno, senza ora)
    const now = new Date();
    const dateOnly = now.toLocaleDateString('it-IT', {
      timeZone: 'Europe/Rome',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    // Rimuovi # dall'order number
    const cleanOrderNumber = (data.orderNumber || '').replace(/^#/, '');

    // Prepara la riga (colonne: Data | Order | Shipment ID | Tracking | Corriere | Costo | URL | Source)
    const row = [
      dateOnly,                                              // Data
      cleanOrderNumber,                                      // Order Number (senza #)
      data.shipmentId || '',                                 // Shipment ID (es. SP123456)
      data.trackingNumber || '',                             // Tracking Number
      data.courierName || '',                                // Corriere
      data.shippingCost?.toFixed(2) || '',                   // Costo (EUR)
      data.labelUrl || '',                                   // URL Etichetta
      'SpedirePro'                                           // Source (per distinguere da Easyship)
    ];

    // Append alla prima colonna disponibile
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A:H',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [row]
      }
    });

    console.log(`[Google Sheets] Logged SpedirePro shipment: Order ${cleanOrderNumber}, Tracking ${data.trackingNumber}`);

  } catch (error) {
    console.error('[Google Sheets] Error logging to sheets:', error);
    throw error;
  }
}
