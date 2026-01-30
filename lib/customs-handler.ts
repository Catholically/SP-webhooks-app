/**
 * Customs declaration handler
 * Orchestrates the entire customs declaration flow
 */

import { requiresCustomsDeclaration, isUSA, isEUCountry, canAutoProcessLabel } from './eu-countries';
import { fetchOrderCustomsData } from './shopify-customs';
import { createCustomsDocumentsFromOrder, DOCUMENT_TYPE_INVOICE, DOCUMENT_TYPE_DECLARATION } from './customs-pdf';
import { uploadToGoogleDrive } from './google-drive';
import { sendCustomsErrorAlert } from './email-alerts';

interface OrderShippingInfo {
  countryCode: string;
  countryName: string;
  receiverName: string;
  receiverAddress: string;
}

/**
 * Check if customs declaration already exists for this order
 */
async function hasExistingCustomsDeclaration(orderId: string): Promise<boolean> {
  const store = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "holy-trove";
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  const adminBase = `https://${store}.myshopify.com/admin/api/${ver}`;
  const token = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";

  const orderGid = orderId.startsWith('gid://')
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const query = `
    query getCustomsMetafield($id: ID!) {
      order(id: $id) {
        metafield(namespace: "custom", key: "doganale") {
          value
        }
      }
    }
  `;

  try {
    const response = await fetch(`${adminBase}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { id: orderGid } }),
    });

    const data = await response.json();
    const metafieldValue = data?.data?.order?.metafield?.value;

    return !!metafieldValue; // Returns true if metafield exists and has a value
  } catch (error) {
    console.error('[Customs] Error checking existing customs declaration:', error);
    return false; // On error, assume it doesn't exist (safe to try generation)
  }
}

/**
 * Fetch order shipping info from Shopify
 */
async function fetchOrderShippingInfo(orderId: string): Promise<OrderShippingInfo | null> {
  const store = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "holy-trove";
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  const adminBase = `https://${store}.myshopify.com/admin/api/${ver}`;
  const token = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";

  const orderGid = orderId.startsWith('gid://')
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const query = `
    query getOrderShipping($id: ID!) {
      order(id: $id) {
        name
        shippingAddress {
          countryCode
          name
          firstName
          lastName
          address1
          address2
          city
          provinceCode
          zip
          country
        }
      }
    }
  `;

  const response = await fetch(`${adminBase}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { id: orderGid } }),
  });

  if (!response.ok) return null;

  const result = await response.json();
  const order = result.data?.order;
  const addr = order?.shippingAddress;

  if (!addr) return null;

  // Format address
  const addressLines = [
    addr.address1,
    addr.address2,
    `${addr.city}, ${addr.provinceCode || ''} ${addr.zip}`,
    addr.country,
  ].filter(Boolean);

  return {
    countryCode: addr.countryCode || '',
    countryName: addr.country || addr.countryCode || '',
    receiverName: addr.name || `${addr.firstName} ${addr.lastName}`.trim(),
    receiverAddress: addressLines.join('\n'),
  };
}

/**
 * Upload a single customs document to SpedirePro (new API - January 2026)
 * Single endpoint: POST /public-api/v1/shipment/{reference}/upload
 * @see https://spedirepro.readme.io/reference/upload-documentazione-doganale
 */
async function uploadDocumentToSpedirePro(
  reference: string,
  pdfBuffer: Buffer,
  documentType: string,  // 'invoice' or 'export_declaration'
  filename: string,
  accountType: string | null = null  // 'DDU' or 'DDP' (null defaults to DDP)
): Promise<boolean> {
  // Select correct API key based on account type
  const isDDU = accountType === "DDU";
  const apiKey = isDDU ? process.env.SPRO_API_KEY_NODDP : process.env.SPRO_API_KEY;
  const SPRO_API_BASE = "https://www.spedirepro.com/public-api/v1";

  if (!apiKey) {
    console.error(`[Customs] ${isDDU ? 'SPRO_API_KEY_NODDP' : 'SPRO_API_KEY'} not configured`);
    return false;
  }

  try {
    console.log(`[Customs] Uploading document type "${documentType}" for reference ${reference} (account: ${accountType || 'DDP'})...`);

    const formData = new FormData();
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    formData.append('document', blob, filename);
    formData.append('document_type', documentType);

    const response = await fetch(
      `${SPRO_API_BASE}/shipment/${reference}/upload`,
      {
        method: 'POST',
        headers: {
          'X-Api-Key': apiKey,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Customs] Failed to upload to SpedirePro: ${response.status} ${errorText}`);
      return false;
    }

    console.log(`[Customs] ✅ Document type "${documentType}" uploaded successfully for reference ${reference}`);
    return true;
  } catch (error) {
    console.error('[Customs] Error uploading to SpedirePro:', error);
    return false;
  }
}

/**
 * Upload both customs documents to SpedirePro
 * document_type 'invoice' = Fattura commerciale
 * document_type 'export_declaration' = Dichiarazione di Libera Esportazione
 */
async function uploadToSpedirePro(
  reference: string,
  tracking: string,
  invoiceBuffer: Buffer,
  declarationBuffer: Buffer,
  accountType: string | null = null
): Promise<{ invoiceSuccess: boolean; declarationSuccess: boolean }> {
  console.log(`[Customs] Uploading both documents to SpedirePro for reference ${reference} (account: ${accountType || 'DDP'})...`);

  // Naming convention from CLAUDE.md: {tracking}_inv.pdf and {tracking}_dog.pdf
  const [invoiceSuccess, declarationSuccess] = await Promise.all([
    uploadDocumentToSpedirePro(reference, invoiceBuffer, DOCUMENT_TYPE_INVOICE, `${tracking}_inv.pdf`, accountType),
    uploadDocumentToSpedirePro(reference, declarationBuffer, DOCUMENT_TYPE_DECLARATION, `${tracking}_dog.pdf`, accountType),
  ]);

  console.log(`[Customs] Upload results - Invoice: ${invoiceSuccess ? '✅' : '❌'}, Declaration: ${declarationSuccess ? '✅' : '❌'}`);

  return { invoiceSuccess, declarationSuccess };
}

/**
 * Update Shopify order with BOTH customs document URLs
 * custom.invoice = Fattura commerciale
 * custom.dichiarazione_doganale = Dichiarazione di libera esportazione
 */
async function updateCustomsMetafields(
  orderId: string,
  invoiceUrl: string,
  declarationUrl: string
): Promise<void> {
  const store = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "holy-trove";
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  const adminBase = `https://${store}.myshopify.com/admin/api/${ver}`;
  const token = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";

  const orderGid = orderId.startsWith('gid://')
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const query = `
    mutation setCustomsMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: orderGid,
        namespace: 'custom',
        key: 'invoice',
        type: 'url',
        value: invoiceUrl,
      },
      {
        ownerId: orderGid,
        namespace: 'custom',
        key: 'dichiarazione_doganale',
        type: 'url',
        value: declarationUrl,
      },
    ],
  };

  const response = await fetch(`${adminBase}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();
  if (result.data?.metafieldsSet?.userErrors?.length > 0) {
    console.error('[Customs] Failed to set customs metafields:', result.data.metafieldsSet.userErrors);
  } else {
    console.log('[Customs] Successfully set custom.invoice and custom.dichiarazione_doganale metafields');
  }
}

/**
 * Main customs declaration handler
 * Called after label creation and tracking number is received
 * @param accountType - 'DDU' or 'DDP' (null defaults to DDP) - used to select correct SpedirePro API key
 */
export async function handleCustomsDeclaration(
  orderId: string,
  orderName: string,
  tracking: string,
  reference: string,
  accountType: string | null = null
): Promise<void> {
  console.log(`[Customs] Starting customs declaration check for order ${orderName}`);

  try {
    // Step 0: Check if customs declaration already exists
    const alreadyExists = await hasExistingCustomsDeclaration(orderId);
    if (alreadyExists) {
      console.log(`[Customs] ✅ Customs declaration already exists for order ${orderName}, skipping`);
      return;
    }

    // Step 1: Fetch shipping info to check country
    const shippingInfo = await fetchOrderShippingInfo(orderId);
    if (!shippingInfo) {
      console.log('[Customs] Could not fetch shipping info, skipping customs');
      return;
    }

    // Step 2: Check if customs declaration is required (non-EU country)
    if (!requiresCustomsDeclaration(shippingInfo.countryCode)) {
      console.log(`[Customs] Country ${shippingInfo.countryCode} is in EU, skipping customs`);
      return;
    }

    console.log(`[Customs] Country ${shippingInfo.countryCode} requires customs declaration`);

    // Step 3: Fetch product customs data from Shopify
    console.log('[Customs] Fetching product customs data...');
    const orderData = await fetchOrderCustomsData(orderId);

    // Check if there are any physical goods to declare
    if (orderData.lineItems.length === 0) {
      console.log('[Customs] No physical goods found in order (only services/insurance), skipping customs declaration');
      return;
    }

    // Step 4: Generate BOTH PDFs (invoice + declaration)
    console.log('[Customs] Generating customs declaration PDFs...');
    const { invoice, declaration } = await createCustomsDocumentsFromOrder(
      orderData,
      tracking,
      shippingInfo.receiverName,
      shippingInfo.receiverAddress
    );

    console.log(`[Customs] PDFs generated - Invoice: ${invoice.length} bytes, Declaration: ${declaration.length} bytes`);

    // Step 5: Upload BOTH documents to SpedirePro (new API - January 2026)
    console.log('[Customs] ========== SPEDIREPRO UPLOAD DEBUG ==========');
    console.log('[Customs] Reference:', reference);
    console.log('[Customs] Account type:', accountType || 'DDP (default)');
    console.log('[Customs] Uploading to SpedirePro (new API v1)...');
    const sproResult = await uploadToSpedirePro(reference, tracking, invoice, declaration, accountType);
    console.log('[Customs] SpedirePro upload result:', sproResult);
    if (!sproResult.invoiceSuccess || !sproResult.declarationSuccess) {
      console.warn(`[Customs] ⚠️ SpedirePro upload incomplete - Invoice: ${sproResult.invoiceSuccess}, Declaration: ${sproResult.declarationSuccess}`);
    } else {
      console.log('[Customs] ✅ Both documents uploaded to SpedirePro successfully');
    }
    console.log('[Customs] ================================================');

    // Step 6: Upload BOTH PDFs to Google Drive with different suffixes
    console.log('[Customs] ========== GOOGLE DRIVE UPLOAD DEBUG ==========');
    const orderNumber = orderName.replace('#', ''); // e.g., "35622182025"
    console.log('[Customs] Order number for filenames:', orderNumber);

    // Upload invoice with _inv suffix
    console.log('[Customs] Uploading invoice to Google Drive...');
    const invoiceDriveUrl = await uploadToGoogleDrive(invoice, `${orderNumber}_inv`, 'customs');
    console.log(`[Customs] ✅ Invoice uploaded: ${invoiceDriveUrl}`);

    // Upload declaration with _dog suffix
    console.log('[Customs] Uploading declaration to Google Drive...');
    const declarationDriveUrl = await uploadToGoogleDrive(declaration, `${orderNumber}_dog`, 'customs');
    console.log(`[Customs] ✅ Declaration uploaded: ${declarationDriveUrl}`);
    console.log('[Customs] =================================================');

    // Step 7: Update BOTH Shopify metafields
    // custom.invoice = Fattura commerciale (_inv)
    // custom.dichiarazione_doganale = Dichiarazione di libera esportazione (_dog)
    console.log('[Customs] ========== SHOPIFY METAFIELDS DEBUG ==========');
    console.log('[Customs] Setting custom.invoice:', invoiceDriveUrl);
    console.log('[Customs] Setting custom.dichiarazione_doganale:', declarationDriveUrl);
    await updateCustomsMetafields(orderId, invoiceDriveUrl, declarationDriveUrl);

    console.log(`[Customs] ✅ Customs declaration completed successfully for order ${orderName}`);
  } catch (error) {
    console.error('[Customs] ❌ Error processing customs declaration:', error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    // If error is due to missing product data, skip silently (Phase 1 orders)
    // These are old orders created before customs automation was implemented
    if (errorMessage.includes('Missing customs data') || errorMessage.includes('No product variant found')) {
      console.warn(`[Customs] ⚠️ Skipping customs for order ${orderName} - missing product data (likely Phase 1 order)`);
      return; // Skip silently, don't send alert
    }

    // For other errors, send alert email
    const missingData = errorMessage.includes('Missing customs data')
      ? errorMessage.split('\n').slice(1)
      : undefined;

    await sendCustomsErrorAlert({
      orderName: orderName,
      orderNumber: orderName.replace('#', ''),
      tracking: tracking,
      errorType: 'Customs Declaration Generation Failed',
      errorDetails: errorMessage,
      missingData: missingData,
      timestamp: new Date(),
    });

    // Don't throw - we don't want to fail the webhook if customs fails
    console.log('[Customs] Error alert sent, continuing with webhook processing');
  }
}
