import type { NextRequest } from "next/server";

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP!;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_WEBHOOK_TOKEN = process.env.SPRO_WEBHOOK_TOKEN!; // simple shared token ?token=xxx

async function shopifyGraphQL<T>(query: string, variables?: any): Promise<T> {
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Shopify GQL ${r.status}: ${text}`);
  }
  const json = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function orderIdByName(name: string): Promise<string | null> {
  const q = /* GraphQL */ `
    query($query: String!) {
      orders(first:1, query:$query){ edges{ node{ id name } } }
    }`;
  const d = await shopifyGraphQL<any>(q, { query: `name:${JSON.stringify(name)}` });
  return d.orders.edges[0]?.node?.id || null;
}

async function setMetafield(orderId: string, key: string, value: string, ns = "spedirepro") {
  const q = /* GraphQL */ `
    mutation($ownerId:ID!, $namespace:String!, $key:String!, $value:String!) {
      metafieldsSet(metafields:[{ownerId:$ownerId,namespace:$namespace,key:$key,type:"single_line_text_field",value:$value}]){
        userErrors{ field message }
      }
    }`;
  await shopifyGraphQL(q, { ownerId: orderId, namespace: ns, key, value });
}

async function createFulfillment(orderId: string, trackingNumber: string, trackingUrl?: string) {
  const q = /* GraphQL */ `
    mutation Fulfill($orderId: ID!, $tracking: String!, $url: URL) {
      fulfillmentCreateV2(fulfillment: {
        lineItemsByFulfillmentOrder: [],
        notifyCustomer: true,
        trackingInfo: { number: $tracking, url: $url, company: "UPS" }
        orderId: $orderId
      }) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`;
  // Note: Using empty lineItemsByFulfillmentOrder lets Shopify auto-allocate remaining items.
  await shopifyGraphQL(q, { orderId, tracking: trackingNumber, url: trackingUrl || null });
}

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token || token !== SPRO_WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
  }

  const body = await req.json().catch(() => ({} as any));

  // Expected payload from SpedirePro
  const merchantRef: string = body.merchant_reference || body.order_name || body.name;  // e.g. "#3557…"
  const reference: string = body.reference || body.ref || "";
  const tracking: string = body.tracking || body.tracking_number || "";
  const trackingUrl: string =
    body.tracking_url ||
    (tracking ? `https://www.ups.com/track?track=yes&trackNums=${encodeURIComponent(tracking)}` : "");
  const labelUrl: string =
    body.label?.link || body.label_url || (reference ? `https://www.spedirepro.com/le-tue-spedizioni/dettagli/${reference}/label` : "");

  if (!merchantRef) {
    return new Response(JSON.stringify({ ok: false, error: "missing merchant_reference" }), { status: 400 });
  }

  const orderId = await orderIdByName(merchantRef);
  if (!orderId) {
    return Response.json({ ok: true, skipped: "order-not-found", ref: merchantRef });
  }

  try {
    if (tracking) {
      await createFulfillment(orderId, tracking, trackingUrl);
    }
    if (reference) await setMetafield(orderId, "reference", reference);
    if (labelUrl) await setMetafield(orderId, "label_url", labelUrl);

    return Response.json({ ok: true, received: true, merchant_reference: merchantRef, reference, tracking, tracking_url: trackingUrl, label_url: labelUrl });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
}
