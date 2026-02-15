// Change runtime to nodejs to support googleapis and pdf-lib
export const runtime = "nodejs";

import { handleCustomsDeclaration } from '@/lib/customs-handler';
import { sendLabelEmail } from '@/lib/email-label';
import { downloadAndUploadToGoogleDrive } from '@/lib/google-drive';
import { logToGoogleSheets } from '@/lib/google-sheets';

type SproWebhook = {
  update_type?: string;
  merchant_reference?: string;
  type?: string;
  order?: string;
  reference?: string;
  tracking?: string;
  courier?: string;
  courier_code?: string;
  courier_group?: string;
  status?: string;
  exception_status?: number;
  tracking_url?: string;
  label?: { link?: string; expire_at?: string };
  label_url?: string;     // Alternative: label URL at root level
  ldv?: string;           // Alternative: Italian "lettera di vettura"
  ldv_url?: string;       // Alternative: LDV URL
  document_url?: string;  // Alternative: generic document URL
  price?: number;         // Shipping cost/price
  cost?: number;          // Alternative field name
};

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const SPRO_API_BASE = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";

/**
 * Recupera il prezzo della spedizione dall'API SpedirePro
 * Endpoint: POST /shipment con reference
 * Uses correct API key based on account type (DDU or DDP)
 */
async function getShipmentPrice(reference: string, accountType: string | null): Promise<number | null> {
  // Select API key based on account type
  const isDDU = accountType === "DDU";
  const apiKey = isDDU ? process.env.SPRO_API_KEY_NODDP : process.env.SPRO_API_KEY;

  if (!apiKey || !reference) {
    console.log(`[SpedirePro API] Missing API key (${isDDU ? 'DDU' : 'DDP'}) or reference, skipping price fetch`);
    return null;
  }

  try {
    console.log(`[SpedirePro API] Fetching price for reference: ${reference} (account: ${accountType || 'DDP'})`);

    const response = await fetch(`${SPRO_API_BASE}/shipment`, {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ reference }),
    });

    if (!response.ok) {
      console.error(`[SpedirePro API] Error fetching shipment: ${response.status}`);
      // Try with the other API key if first one fails
      if (!isDDU) {
        console.log("[SpedirePro API] Retrying with DDU API key...");
        return getShipmentPrice(reference, "DDU");
      }
      return null;
    }

    const data = await response.json();
    const price = data?.price;

    if (price !== undefined && price !== null) {
      console.log(`[SpedirePro API] Found price: ${price} EUR`);
      return typeof price === 'number' ? price : parseFloat(price);
    }

    console.log("[SpedirePro API] No price in response");
    return null;
  } catch (error) {
    console.error("[SpedirePro API] Error:", error);
    return null;
  }
}

function adminBase() {
  const store = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "holy-trove";
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  return `https://${store}.myshopify.com/admin/api/${ver}`;
}

async function shopifyFetch(path: string, init?: RequestInit) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";
  return fetch(`${adminBase()}${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

async function findOrderIdByName(nameRaw: string): Promise<string | null> {
  const name = nameRaw?.trim();
  if (!name) return null;
  const withHash = name.startsWith("#") ? name : `#${name}`;
  const q = encodeURIComponent(withHash);
  const r = await shopifyFetch(`/orders.json?status=any&name=${q}`, { method: "GET" });
  if (!r.ok) return null;
  const data = await r.json();
  const id = data?.orders?.[0]?.id;
  return id ? String(id) : null;
}

async function getOrderMetafield(orderGid: string, namespace: string, key: string): Promise<string | null> {
  const q = `
    query($id: ID!, $namespace: String!, $key: String!) {
      order(id: $id) {
        metafield(namespace: $namespace, key: $key) {
          value
        }
      }
    }`;
  const r = await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q, variables: { id: orderGid, namespace, key } }),
  });
  const jsonData = await r.json();
  return jsonData?.data?.order?.metafield?.value || null;
}

async function getOrderCustomerName(orderGid: string): Promise<string> {
  const q = `
    query($id: ID!) {
      order(id: $id) {
        customer {
          displayName
          firstName
          lastName
        }
        shippingAddress {
          name
        }
      }
    }`;
  const r = await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q, variables: { id: orderGid } }),
  });
  const jsonData = await r.json();
  const customer = jsonData?.data?.order?.customer;
  const shippingAddress = jsonData?.data?.order?.shippingAddress;

  // Try to get customer name from different sources
  return customer?.displayName ||
         `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() ||
         shippingAddress?.name ||
         "Cliente";
}

async function metafieldsSet(orderGid: string, kv: Record<string, string>, reference?: string, shippingCost?: number | null) {
  const entries = Object.entries(kv).map(([key, value]) => {
    // Determina il tipo corretto in base al campo
    let type = "single_line_text_field";
    if (key === "ldv_url" || key === "label_url" || key === "tracking_url") {
      type = "url";
    }

    return {
      ownerId: orderGid,
      namespace: "spedirepro",
      key,
      type,
      value,
    };
  });

  // Add spro.reference metafield if reference is provided
  if (reference) {
    entries.push({
      ownerId: orderGid,
      namespace: "spro",
      key: "reference",
      type: "single_line_text_field",
      value: reference,
    });
  }

  // Add custom.costo_spedizione metafield (same as Easyship webhook)
  if (shippingCost !== undefined && shippingCost !== null) {
    entries.push({
      ownerId: orderGid,
      namespace: "custom",
      key: "costo_spedizione",
      type: "single_line_text_field",
      value: shippingCost.toFixed(2),  // Solo numero, es. "12.35"
    });
  }

  console.log("Setting metafields:", entries);

  const q = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors { field message }
      }
    }`;
  const r = await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q, variables: { metafields: entries } }),
  });

  const result = await r.json();
  if (result.data?.metafieldsSet?.userErrors?.length > 0) {
    console.error("Metafields errors:", result.data.metafieldsSet.userErrors);
  } else {
    console.log("Metafields created:", result.data?.metafieldsSet?.metafields);
  }
}

async function getAllOpenFulfillmentOrders(orderGid: string): Promise<string[]> {
  const q = `
    query($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 10) {
          nodes {
            id
            status
            assignedLocation {
              name
            }
          }
        }
      }
    }`;
  const r = await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q, variables: { id: orderGid } }),
  });
  const jsonData = await r.json();
  const fulfillmentOrders = jsonData?.data?.order?.fulfillmentOrders?.nodes || [];

  console.log("Available fulfillment orders:", fulfillmentOrders);

  // Get ALL OPEN fulfillment orders (for multi-location orders)
  const openFOs = fulfillmentOrders.filter((fo: any) => fo.status === "OPEN");
  if (openFOs.length > 0) {
    console.log(`Found ${openFOs.length} OPEN fulfillment order(s):`);
    openFOs.forEach((fo: any) => {
      console.log(`  - ${fo.id} at location: ${fo.assignedLocation?.name}`);
    });
    return openFOs.map((fo: any) => fo.id);
  }

  console.log("No OPEN fulfillment orders found");
  return [];
}

async function fulfill(foId: string, tracking: string, trackingUrl?: string, company?: string) {
  const q = `
    mutation fulfill($fulfillmentOrderId: ID!, $trackingInfo: FulfillmentTrackingInput) {
      fulfillmentCreateV2(fulfillment: {
        lineItemsByFulfillmentOrder: { fulfillmentOrderId: $fulfillmentOrderId }
        trackingInfo: $trackingInfo
        notifyCustomer: true
      }) {
        fulfillment { id }
        userErrors { field message }
      }
    }`;
  const vars = {
    fulfillmentOrderId: foId,
    trackingInfo: {
      number: tracking,
      url: trackingUrl || null,
      company: company || "UPS",
    },
  };
  await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query: q, variables: vars }) });
}

export async function POST(req: Request) {
  // token check
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.SPRO_WEBHOOK_TOKEN || "";
  if (!expected || token !== expected) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  // parse body
  let body: SproWebhook | null = null;
  try {
    body = await req.json();
    console.log("SpedirePro webhook received:", JSON.stringify(body, null, 2));
  } catch {
    return json(400, { ok: false, error: "bad json" });
  }

  const merchantRef = body?.merchant_reference || "";
  const tracking = body?.tracking || "";
  const trackingUrl = body?.tracking_url || body?.label?.link || "";

  // Try multiple possible locations for label URL (SpedirePro may have changed payload structure)
  const labelUrl = body?.label?.link || body?.label_url || body?.ldv || body?.ldv_url || body?.document_url || "";

  const courier = body?.courier || body?.courier_group || "UPS"; // Nome completo per metafields
  const courierGroup = body?.courier_group || body?.courier?.split(" ")[0] || "UPS"; // Nome standard per Shopify

  // Enhanced logging to debug payload structure
  console.log("========== SPEDIREPRO WEBHOOK DEBUG ==========");
  console.log("Full payload keys:", Object.keys(body || {}));
  console.log("Label object:", JSON.stringify(body?.label, null, 2));
  console.log("Alternative label fields:", {
    "label?.link": body?.label?.link,
    "label_url": body?.label_url,
    "ldv": body?.ldv,
    "ldv_url": body?.ldv_url,
    "document_url": body?.document_url,
  });
  console.log("Final labelUrl resolved:", labelUrl || "(EMPTY - THIS IS THE PROBLEM!)");
  console.log("==============================================");

  console.log("Extracted values:", {
    merchantRef,
    tracking,
    trackingUrl,
    labelUrl,
    courier,
    courierGroup,
    rawCourier: body?.courier,
    rawCourierGroup: body?.courier_group
  });

  if (!merchantRef || !tracking) {
    return json(200, { ok: true, skipped: "missing merchant_reference or tracking" });
  }

  const orderIdNum = await findOrderIdByName(merchantRef);
  if (!orderIdNum) {
    return json(200, { ok: true, skipped: "order not found by name", merchant_reference: merchantRef });
  }
  const orderGid = `gid://shopify/Order/${orderIdNum}`;

  // Prepare metafields object
  const metafields: Record<string, string> = {
    reference: body?.reference || "",
    order_ref: body?.order || "",
    tracking,
    label_url: labelUrl,
    ldv_url: labelUrl,  // Will be updated with Google Drive URL
    courier,  // Nome completo (es: "UPS STANDARD - PROMO")
    courier_group: courierGroup,  // Nome standard (es: "UPS")
  };

  // Only add tracking URL metafield if it has value
  if (trackingUrl) metafields.tracking_url = trackingUrl;

  // Get account type from metafield (saved when label was created)
  const accountType = await getOrderMetafield(orderGid, "spedirepro", "account_type");
  console.log(`[SpedirePro] Account type for order ${merchantRef}: ${accountType || 'DDP (default)'}`);

  // Get shipping price: first try webhook payload, then call SpedirePro API
  let shippingPrice: number | null = body?.price ?? body?.cost ?? null;

  if (shippingPrice === null && body?.reference) {
    // Webhook doesn't include price, fetch it from SpedirePro API
    shippingPrice = await getShipmentPrice(body.reference, accountType);
  }

  if (shippingPrice !== null) {
    metafields.shipping_price = String(shippingPrice);
  }

  // Download label from AWS and upload to Google Drive for permanent storage
  let permanentLabelUrl = labelUrl; // Fallback to original URL
  if (labelUrl) {
    try {
      console.log("[Label Storage] ✅ Label URL found, downloading and uploading to Google Drive...");
      console.log("[Label Storage] Source URL:", labelUrl);
      const orderNumber = merchantRef.replace('#', ''); // e.g., "35622182025"
      permanentLabelUrl = await downloadAndUploadToGoogleDrive(labelUrl, orderNumber, 'label');
      console.log("[Label Storage] ✅ Label stored on Google Drive:", permanentLabelUrl);

      // Update metafields with permanent Google Drive URL
      metafields.label_url = permanentLabelUrl;
      metafields.ldv_url = permanentLabelUrl;  // Aggiunto per compatibilità
    } catch (err) {
      console.error("[Label Storage] ❌ Failed to upload label to Google Drive:", err);
      // Fallback to AWS URL
      metafields.label_url = labelUrl;
      metafields.ldv_url = labelUrl;
    }
  } else {
    console.error("[Label Storage] ⚠️ NO LABEL URL IN WEBHOOK PAYLOAD!");
    console.error("[Label Storage] This means SpedirePro did not send a label link.");
    console.error("[Label Storage] Metafields will be set with EMPTY label URLs.");
  }

  await metafieldsSet(orderGid, metafields, body?.reference, shippingPrice);

  console.log("Metafields set successfully for order:", orderIdNum);

  // Log spedizione su Google Sheets (non bloccante - errori non interrompono il flusso)
  await logToGoogleSheets({
    orderNumber: merchantRef,
    shipmentId: body?.reference || '',
    trackingNumber: tracking,
    courierName: courier,
    shippingCost: shippingPrice ?? null,
    labelUrl: permanentLabelUrl
  }).catch(err => console.error('[Google Sheets] Logging failed:', err.message));

  // Check if order needs label email sent (set by MI-CREATE or MI-CREATE-NOD tags)
  if (permanentLabelUrl) {
    try {
      const emailRecipient = await getOrderMetafield(orderGid, "spedirepro", "label_email_recipient");
      console.log("[Label Email] Email recipient metafield:", emailRecipient);

      if (emailRecipient) {
        console.log(`[Label Email] Sending label email to ${emailRecipient} with PDF attachment`);
        await sendLabelEmail(merchantRef, permanentLabelUrl, undefined, emailRecipient);
      } else {
        console.log("[Label Email] No email recipient set, skipping label email");
      }
    } catch (err) {
      console.error("[Label Email] Error checking metafield or sending email:", err);
      // Don't fail the webhook - just log the error
    }
  }

  // Auto-fulfill ALL open fulfillment orders with tracking information
  // This handles multi-location orders by fulfilling all locations with same tracking
  // Uses courier_group for Shopify (e.g., "UPS" instead of "UPS STANDARD - PROMO")
  console.log("[DEBUG] Looking for fulfillment orders...");
  const foIds = await getAllOpenFulfillmentOrders(orderGid);
  console.log(`[DEBUG] Found ${foIds.length} fulfillment order(s) to fulfill`);

  if (foIds.length > 0) {
    console.log("[DEBUG] Starting fulfillment with tracking:", tracking);

    // Fulfill all open fulfillment orders with the same tracking number
    for (const foId of foIds) {
      try {
        await fulfill(foId, tracking, trackingUrl, courierGroup);
        console.log(`[DEBUG] ✅ Fulfillment completed for ${foId}`);
      } catch (err) {
        console.error(`[DEBUG] ❌ Fulfillment error for ${foId}:`, err);
        // Continue with other fulfillment orders even if one fails
      }
    }

    console.log(`[DEBUG] ✅ All fulfillments completed (${foIds.length} total)`);
  } else {
    console.log("[DEBUG] ⚠️ No fulfillment orders found - skipping fulfillment");
  }

  // Process customs declaration (await to ensure it completes)
  // This will check if destination is extra-EU and generate customs docs if needed
  const reference = body?.reference || "";
  if (reference) {
    // Check if order has skip_customs_auto metafield (set by -NOD tags)
    const skipCustomsAuto = await getOrderMetafield(orderGid, "spedirepro", "skip_customs_auto");

    if (skipCustomsAuto === "true") {
      console.log(`[Customs] ⏭️ Skipping automatic customs generation for order ${merchantRef} (skip_customs_auto metafield set)`);
      console.log('[Customs] User will manually generate customs declaration using RM-DOG or MI-DOG tag');
    } else {
      try {
        // Pass accountType to customs handler so it uses correct API key
        await handleCustomsDeclaration(orderIdNum, merchantRef, tracking, reference, accountType);
      } catch (err) {
        console.error('[Webhook] Error in customs processing:', err);
        // Don't fail the webhook - just log the error
      }
    }
  }

  return json(200, { ok: true, order_id: orderIdNum, tracking, label_url: labelUrl });
}

export async function GET() {
  return new Response('Method Not Allowed', { status: 405 });
}
