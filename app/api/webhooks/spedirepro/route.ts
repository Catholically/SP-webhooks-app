export const runtime = "edge";

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
  } catch {
    return json(400, { ok: false, error: "bad json" });
  }

  const merchantRef = body?.merchant_reference || "";
  const tracking = body?.tracking || "";
  const trackingUrl = body?.tracking_url || body?.label?.link || "";
  const labelUrl = body?.label?.link || "";
  const courier = body?.courier || body?.courier_group || "UPS";

  if (!merchantRef || !tracking) {
    return json(200, { ok: true, skipped: "missing merchant_reference or tracking" });
  }

  const orderIdNum = await findOrderIdByName(merchantRef);
  if (!orderIdNum) {
    return json(200, { ok: true, skipped: "order not found by name", merchant_reference: merchantRef });
  }
  const orderGid = `gid://shopify/Order/${orderIdNum}`;

  await metafieldsSet(orderGid, {
    reference: body.reference || "",
    order_ref: body.order || "",
    tracking,
    tracking_url: trackingUrl,
    label_url: labelUrl,
    courier,
  });

  // Auto-fulfill the order with tracking information
  const foId = await firstFO(orderGid);
  if (foId) {
    await fulfill(foId, tracking, trackingUrl, courier);
  }

  return json(200, { ok: true, order_id: orderIdNum, tracking, label_url: labelUrl });
}

export async function GET() {
  return new Response('Method Not Allowed', { status: 405 });
}
