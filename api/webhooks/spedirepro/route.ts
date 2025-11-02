// Runtime: Edge
export const runtime = "edge";

/**
 * ENV richieste:
 * - SPRO_WEBHOOK_TOKEN
 * - SHOPIFY_STORE                es. "holy-trove"
 * - SHOPIFY_ADMIN_TOKEN          Admin API access token
 * - SHOPIFY_API_VERSION          es. "2025-10" (default)
 * - FULFILLMENT_ENABLE           "true" | "false"  (default "true")
 */

type SproWebhook = {
  update_type?: string;
  merchant_reference?: string; // atteso = nome ordine Shopify (con o senza #)
  type?: string;
  order?: string;              // ref interno SPRO
  reference?: string;          // ref etichetta SPRO
  tracking?: string;
  courier?: string;
  courier_code?: string;
  courier_group?: string;
  status?: string;
  exception_status?: number;
  tracking_url?: string;
  label?: { link?: string; expire_at?: string };
};

const j = (v: unknown) => new Response(JSON.stringify(v), {
  status: 200,
  headers: { "content-type": "application/json" },
});

function bad(status: number, msg: string) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function adminBase() {
  const store = process.env.SHOPIFY_STORE!;
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  return `https://${store}.myshopify.com/admin/api/${ver}`;
}

async function shopifyFetch(path: string, init?: RequestInit) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN!;
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
  // normalizza: con e senza "#"
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

async function orderGID(orderIdNum: string): Promise<string> {
  // REST id → GraphQL gid
  return `gid://shopify/Order/${orderIdNum}`;
}

async function setOrderMetafields(orderGid: string, kv: Record<string, string>) {
  const entries = Object.entries(kv).map(([key, value]) => ({
    ownerId: orderGid,
    namespace: "spedirepro",
    key,
    type: "single_line_text_field",
    value,
  }));
  const q = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`;
  await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q, variables: { metafields: entries } }),
  });
}

async function getFirstFulfillmentOrderId(orderGid: string): Promise<string | null> {
  const q = `
    query($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 5) { nodes { id status lineItems(first: 50){nodes{id quantity remainingQuantity}} } }
      }
    }`;
  const r = await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q, variables: { id: orderGid } }),
  });
  const json = await r.json();
  const node = json?.data?.order?.fulfillmentOrders?.nodes?.[0];
  return node?.id || null;
}

async function createFulfillment(orderGid: string, foId: string, tracking: string, trackingUrl?: string, company?: string) {
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
  await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q, variables: vars }),
  });
}

export async function POST(req: Request) {
  // Token query check
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (!process.env.SPRO_WEBHOOK_TOKEN || token !== process.env.SPRO_WEBHOOK_TOKEN) {
    return bad(401, "unauthorized");
  }

  let body: SproWebhook | null = null;
  try { body = await req.json() as SproWebhook; } catch { return bad(400, "bad json"); }

  // Log minimale
  console.log("SPRO webhook", JSON.stringify(body));

  // Dati essenziali
  const merchantRef = body?.merchant_reference || "";
  const tracking = body?.tracking || "";
  const trackingUrl = body?.tracking_url || body?.label?.link || "";
  const labelUrl = body?.label?.link || "";
  const courier = body?.courier || body?.courier_group || "UPS";
  if (!merchantRef || !tracking) return j({ ok: true, skipped: "missing merchant_reference or tracking" });

  // 1) Trova ordine
  const orderIdNum = await findOrderIdByName(merchantRef);
  if (!orderIdNum) return j({ ok: true, skipped: "order not found by name", merchant_reference: merchantRef });

  const gid = await orderGID(orderIdNum);

  // 2) Metafields
  await setOrderMetafields(gid, {
    reference: body.reference || "",
    order_ref: body.order || "",
    tracking,
    tracking_url: trackingUrl,
    label_url: labelUrl,
    courier,
  });

  // 3) Fulfillment opzionale
  const doFulfill = (process.env.FULFILLMENT_ENABLE || "true") === "true";
  if (doFulfill) {
    const foId = await getFirstFulfillmentOrderId(gid);
    if (foId) await createFulfillment(gid, foId, tracking, trackingUrl, courier);
  }

  return j({ ok: true, order_id: orderIdNum, tracking, label_url: labelUrl });
}
