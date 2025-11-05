/**
 * Customs declaration handler
 * Orchestrates the entire customs declaration flow
 */

import { requiresCustomsDeclaration } from './eu-countries';
import { fetchOrderCustomsData } from './shopify-customs';
import { createCustomsDeclarationFromOrder } from './customs-pdf';
import { uploadToGoogleDrive } from './google-drive';
import { sendCustomsErrorAlert } from './email-alerts';

interface OrderShippingInfo {
  countryCode: string;
  receiverName: string;
  receiverAddress: string;
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
    receiverName: addr.name || `${addr.firstName} ${addr.lastName}`.trim(),
    receiverAddress: addressLines.join('\n'),
  };
}

/**
 * Upload customs declaration to SpedirePro
 */
async function uploadToSpedirePro(
  reference: string,
  pdfBuffer: Buffer
): Promise<boolean> {
  const SPRO_API_KEY = process.env.SPRO_API_KEY;
  const SPRO_API_BASE = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";

  if (!SPRO_API_KEY) {
    console.error('[Customs] SPRO_API_KEY not configured');
    return false;
  }

  try {
    // Create FormData for multipart upload
    const formData = new FormData();
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    formData.append('document', blob, 'customs.pdf');

    const response = await fetch(
      `${SPRO_API_BASE}/shipment/${reference}/upload`,
      {
        method: 'POST',
        headers: {
          'X-Api-Key': SPRO_API_KEY,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Customs] Failed to upload to SpedirePro: ${response.status} ${errorText}`);
      return false;
    }

    console.log(`[Customs] Successfully uploaded to SpedirePro reference ${reference}`);
    return true;
  } catch (error) {
    console.error('[Customs] Error uploading to SpedirePro:', error);
    return false;
  }
}

/**
 * Update Shopify order with customs document URL
 */
async function updateCustomsMetafield(
  orderId: string,
  driveUrl: string
): Promise<void> {
  const store = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "holy-trove";
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  const adminBase = `https://${store}.myshopify.com/admin/api/${ver}`;
  const token = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";

  const orderGid = orderId.startsWith('gid://')
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const query = `
    mutation setCustomsMetafield($metafields: [MetafieldsSetInput!]!) {
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
        key: 'dichiarazione_doganale',
        type: 'url',
        value: driveUrl,
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
    console.error('[Customs] Failed to set customs metafield:', result.data.metafieldsSet.userErrors);
  } else {
    console.log('[Customs] Successfully set custom.doganale metafield');
  }
}

/**
 * Main customs declaration handler
 * Called after label creation and tracking number is received
 */
export async function handleCustomsDeclaration(
  orderId: string,
  orderName: string,
  tracking: string,
  reference: string
): Promise<void> {
  console.log(`[Customs] Starting customs declaration check for order ${orderName}`);

  try {
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

    // Step 4: Generate PDF
    console.log('[Customs] Generating customs declaration PDF...');
    const pdfBuffer = await createCustomsDeclarationFromOrder(
      orderData,
      tracking,
      shippingInfo.receiverName,
      shippingInfo.receiverAddress
    );

    console.log(`[Customs] PDF generated, size: ${pdfBuffer.length} bytes`);

    // Step 5: Upload to SpedirePro
    console.log('[Customs] Uploading to SpedirePro...');
    const sproSuccess = await uploadToSpedirePro(reference, pdfBuffer);
    if (!sproSuccess) {
      console.warn('[Customs] Failed to upload to SpedirePro, but continuing with Drive upload');
    }

    // Step 6: Upload to Google Drive with tracking number as filename
    console.log('[Customs] Uploading to Google Drive...');
    const driveUrl = await uploadToGoogleDrive(pdfBuffer, tracking);
    console.log(`[Customs] Uploaded to Google Drive: ${driveUrl}`);

    // Step 7: Update Shopify metafield custom.doganale
    console.log('[Customs] Updating Shopify metafield...');
    await updateCustomsMetafield(orderId, driveUrl);

    console.log(`[Customs] ✅ Customs declaration completed successfully for order ${orderName}`);
  } catch (error) {
    console.error('[Customs] ❌ Error processing customs declaration:', error);

    // Send error alert email
    const errorMessage = error instanceof Error ? error.message : String(error);
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
