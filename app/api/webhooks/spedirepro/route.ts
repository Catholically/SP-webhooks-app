// Change runtime to nodejs to support pdfkit and other Node.js libraries
export const runtime = "nodejs";

import { handleCustomsDeclaration } from '@/lib/customs-handler';

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
};

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function adminBase() {
  const store = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "holy-trove";
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  return `https://${store}.myshopify.com/admin/api/${ver}`;
}

async function shopifyFetch(path: string, init?: RequestInit) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";
  console.log("[DEBUG] Shopify token exists:", !!token, "length:", token.length);
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

async function metafieldsSet(orderGid: string, kv: Record<string, string>) {
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

async function firstFO(orderGid: string): Promise<string | null> {
  const q = `
    query($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 5) { nodes { id status } }
      }
    }`;
  const r = await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q, variables: { id: orderGid } }),
  });
  const jsonData = await r.json();
  return jsonData?.data?.order?.fulfillmentOrders?.nodes?.[0]?.id || null;
}

async function fulfill(foId: string, tracking: string, trackingUrl?: string, company?: string) {
  const q = `
    mutation fulfill($fulfillmentOrderId: ID!, $trackingInfo: FulfillmentTrackingInput) {
      fulfillmentCreateV2(fulfillment: {
        lineItemsByFulfillmentOrder: { fulfillmentOrderId: $fulfillmentOrderId }
        trackingInfo: $trackingInfo
        notifyCustomer: false
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

  console.log("[DEBUG] Fulfill mutation variables:", JSON.stringify(vars, null, 2));
  const response = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query: q, variables: vars }) });
  const result = await response.json();

  console.log("[DEBUG] Fulfill mutation response:", JSON.stringify(result, null, 2));

  if (result.data?.fulfillmentCreateV2?.userErrors?.length > 0) {
    console.error("[DEBUG] ❌ Fulfillment userErrors:", result.data.fulfillmentCreateV2.userErrors);
    throw new Error(`Fulfillment failed: ${JSON.stringify(result.data.fulfillmentCreateV2.userErrors)}`);
  }

  if (result.data?.fulfillmentCreateV2?.fulfillment?.id) {
    console.log("[DEBUG] ✅ Fulfillment created successfully:", result.data.fulfillmentCreateV2.fulfillment.id);
  } else {
    console.error("[DEBUG] ❌ Unexpected fulfillment response (no fulfillment ID)");
  }
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
  const labelUrl = body?.label?.link || "";
  const courier = body?.courier || body?.courier_group || "UPS"; // Nome completo per metafields
  const courierGroup = body?.courier_group || body?.courier?.split(" ")[0] || "UPS"; // Nome standard per Shopify

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

  console.log("[DEBUG] About to find order by name:", merchantRef);

  const orderIdNum = await findOrderIdByName(merchantRef);
  console.log("[DEBUG] Order ID found:", orderIdNum);
  if (!orderIdNum) {
    return json(200, { ok: true, skipped: "order not found by name", merchant_reference: merchantRef });
  }
  const orderGid = `gid://shopify/Order/${orderIdNum}`;

  // Build metafields object, excluding empty URLs (Shopify doesn't accept empty URL metafields)
  const metafields: Record<string, string> = {
    reference: body?.reference || "",
    order_ref: body?.order || "",
    tracking,
    courier,  // Nome completo (es: "UPS STANDARD - PROMO")
    courier_group: courierGroup,  // Nome standard (es: "UPS")
  };

  // Only add URL metafields if they have values
  if (trackingUrl) metafields.tracking_url = trackingUrl;
  if (labelUrl) {
    metafields.label_url = labelUrl;
    metafields.ldv_url = labelUrl;  // Aggiunto per compatibilità
  }

  await metafieldsSet(orderGid, metafields);

  console.log("Metafields set successfully for order:", orderIdNum);

  // Auto-fulfill the order with tracking information
  // Usa courier_group per Shopify (es: "UPS" invece di "UPS STANDARD - PROMO")
  console.log("[DEBUG] Looking for fulfillment order...");
  const foId = await firstFO(orderGid);
  console.log("[DEBUG] Fulfillment Order ID found:", foId);

  if (foId) {
    console.log("[DEBUG] Starting fulfillment with tracking:", tracking);
    try {
      await fulfill(foId, tracking, trackingUrl, courierGroup);
      console.log("[DEBUG] ✅ Fulfillment completed successfully");
    } catch (err) {
      console.error("[DEBUG] ❌ Fulfillment error:", err);
    }
  } else {
    console.log("[DEBUG] ⚠️ No fulfillment order found - skipping fulfillment");
  }

  // Process customs declaration (await to ensure it completes)
  // This will check if destination is extra-EU and generate customs docs if needed
  const reference = body?.reference || "";
  if (reference) {
    try {
      await handleCustomsDeclaration(orderIdNum, merchantRef, tracking, reference);
    } catch (err) {
      console.error('[Webhook] Error in customs processing:', err);
      // Don't fail the webhook - just log the error
    }
  }

  return json(200, { ok: true, order_id: orderIdNum, tracking, label_url: labelUrl });
}

export async function GET() {
  return new Response('Method Not Allowed', { status: 405 });
}
