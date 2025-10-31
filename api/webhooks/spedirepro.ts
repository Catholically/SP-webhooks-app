// api/webhooks/spedirepro.ts
// Next.js Edge runtime
// ENV:
// SHOPIFY_SHOP=holy-trove.myshopify.com
// SHOPIFY_ADMIN_TOKEN=shpat_...
// DEFAULT_CARRIER_NAME=UPS
// SPRO_WEBHOOK_TOKEN=spro_2e9c41c3b4a14c8b9f7d8a1fcd392b72

import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const CARRIER = process.env.DEFAULT_CARRIER_NAME || "UPS";
const WEBHOOK_TOKEN = process.env.SPRO_WEBHOOK_TOKEN;

type SpedireProWebhook = {
  merchant_reference?: string;
  reference?: string;
  tracking?: string;
  tracking_url?: string;
  label?: { link?: string };
};

type GQLRaw = { data?: any; errors?: { message: string }[] };

async function shopifyGraphQL<T = GQLRaw>(query: string, variables?: Record<string, any>): Promise<T & GQLRaw> {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch {
    throw new Error(`Shopify GQL HTTP ${res.status}: non-JSON response: ${text.slice(0,300)}`);
  }
  if (!res.ok) throw new Error(`Shopify GQL HTTP ${res.status}: ${text}`);
  if (json?.errors?.length) throw new Error(`Shopify GQL errors: ${json.errors.map((e: any)=>e.message).join("; ")}`);
  return json;
}

function normalizeRef(refRaw: string) {
  const ref = refRaw.trim();
  const hasHash = ref.startsWith("#");
  const name = ref.replace(/^#/, "");
  const numericId = /^\d+$/.test(ref) ? ref : undefined;
  const nameWithHash = hasHash ? ref : `#${name}`;
  return { name, nameWithHash, numericId };
}

async function findOrderByRef(merchantRef: string): Promise<{ id: string; name: string } | null> {
  const { name, nameWithHash, numericId } = normalizeRef(merchantRef);

  // 1) prova ID diretto
  if (numericId) {
    const gid = `gid://shopify/Order/${numericId}`;
    const q = `query($id: ID!){ order(id:$id){ id name } }`;
    try {
      const r = await shopifyGraphQL(q, { id: gid });
      const order = r?.data?.order;
      if (order?.id) return order;
    } catch { /* passa a search */ }
  }

  // 2) search per name con hash poi senza
  const q = `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id name } } } }`;
  async function search(term: string) {
    const r = await shopifyGraphQL(q, { q: `status:any name:${JSON.stringify(term)}` });
    return r?.data?.orders?.edges?.[0]?.node ?? null;
  }
  return (await search(nameWithHash)) ?? (await search(name)) ?? null;
}

async function getFulfillmentOrderLineItems(orderId: string) {
  const q = `
    query($id:ID!){
      order(id:$id){
        id
        fulfillmentOrders(first:10){
          edges{
            node{
              id
              lineItems(first:100){ edges{ node{ id remainingQuantity } } }
            }
          }
        }
      }
    }`;
  const r = await shopifyGraphQL(q, { id: orderId });
  const order = r?.data?.order;
  if (!order) throw new Error("order not found when fetching fulfillmentOrders");
  const items: { fulfillmentOrderId: string; lineItemId: string; qty: number }[] = [];
  for (const fo of order.fulfillmentOrders?.edges ?? []) {
    for (const li of fo?.node?.lineItems?.edges ?? []) {
      const rem = li?.node?.remainingQuantity ?? 0;
      if (rem > 0) items.push({ fulfillmentOrderId: fo.node.id, lineItemId: li.node.id, qty: rem });
    }
  }
  return items;
}

async function createFulfillment(
  items: { fulfillmentOrderId: string; lineItemId: string; qty: number }[],
  trackingNumber: string | undefined,
  trackingUrl: string | undefined,
  trackingCompany: string,
) {
  const byFO = new Map<string, { id: string; lineItems: { id: string; quantity: number }[] }>();
  for (const it of items) {
    const g = byFO.get(it.fulfillmentOrderId) || { id: it.fulfillmentOrderId, lineItems: [] };
    g.lineItems.push({ id: it.lineItemId, quantity: it.qty });
    byFO.set(it.fulfillmentOrderId, g);
  }
  const m = `
    mutation($input: FulfillmentCreateV2Input!){
      fulfillmentCreateV2(input:$input){
        fulfillment{ id }
        userErrors{ message }
      }
    }`;
  const input = {
    notifyCustomer: false,
    trackingInfo: { company: trackingCompany, number: trackingNumber ?? "", url: trackingUrl ?? "" },
    lineItemsByFulfillmentOrder: Array.from(byFO.values()).map(g => ({
      fulfillmentOrderId: g.id,
      fulfillmentOrderLineItems: g.lineItems,
    })),
  };
  const r = await shopifyGraphQL(m, { input });
  const errs = r?.data?.fulfillmentCreateV2?.userErrors ?? [];
  if (errs.length) throw new Error("fulfillmentCreateV2 errors: " + errs.map((e: any)=>e.message).join("; "));
  return r?.data?.fulfillmentCreateV2?.fulfillment?.id ?? null;
}

async function setOrderMetafield(orderId: string, labelUrl?: string) {
  if (!labelUrl) return;
  const m = `
    mutation($metafields:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$metafields){ userErrors{ message } }
    }`;
  const metafields = [{
    ownerId: orderId, namespace: "spro", key: "label_url",
    type: "single_line_text_field", value: labelUrl,
  }];
  const r = await shopifyGraphQL(m, { metafields });
  const errs = r?.data?.metafieldsSet?.userErrors ?? [];
  if (errs.length) throw new Error("metafieldsSet errors: " + errs.map((e: any)=>e.message).join("; "));
}

async function swapTags(orderId: string) {
  const m = `
    mutation($id:ID!){
      add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
      rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
    }`;
  const r = await shopifyGraphQL(m, { id: orderId });
  const addErrs = r?.data?.add?.userErrors ?? [];
  const remErrs = r?.data?.rem?.userErrors ?? [];
  const errs = [...addErrs, ...remErrs];
  if (errs.length) throw new Error("tag errors: " + errs.map((e: any)=>e.message).join("; "));
}

async function getLatestFulfillmentId(orderId: string) {
  const q = `
    query($id:ID!){
      order(id:$id){
        fulfillments(first:10, reverse:true){ edges{ node{ id } } }
      }
    }`;
  const r = await shopifyGraphQL(q, { id: orderId });
  return r?.data?.order?.fulfillments?.edges?.[0]?.node?.id ?? null;
}

async function updateFulfillmentTracking(
  fulfillmentId: string,
  trackingNumber: string | undefined,
  trackingUrl: string | undefined,
  trackingCompany: string,
) {
  const m = `
    mutation($id:ID!, $info:FulfillmentTrackingInput!, $notify:Boolean!){
      fulfillmentTrackingInfoUpdateV2(
        fulfillmentId:$id, trackingInfo:$info, notifyCustomer:$notify
      ){
        fulfillment{ id }
        userErrors{ message }
      }
    }`;
  const vars = {
    id: fulfillmentId,
    info: { company: trackingCompany, number: trackingNumber ?? "", url: trackingUrl ?? "" },
    notify: false,
  };
  const r = await shopifyGraphQL(m, vars);
  const errs = r?.data?.fulfillmentTrackingInfoUpdateV2?.userErrors ?? [];
  if (errs.length) throw new Error("trackingUpdate errors: " + errs.map((e: any)=>e.message).join("; "));
}

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method-not-allowed" }), { status: 405 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (WEBHOOK_TOKEN && token !== WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
  }

  let payload: SpedireProWebhook;
  try { payload = await req.json(); }
  catch { return new Response(JSON.stringify({ ok: false, error: "invalid-json" }), { status: 400 }); }

  const { merchant_reference, tracking, tracking_url, label } = payload;
  if (!merchant_reference) {
    return new Response(JSON.stringify({ ok: false, error: "missing-merchant_reference" }), { status: 400 });
  }

  try {
    const order = await findOrderByRef(merchant_reference);
    if (!order) {
      return new Response(JSON.stringify({ ok: true, skipped: "order-not-found", ref: merchant_reference }), { status: 200 });
    }

    const items = await getFulfillmentOrderLineItems(order.id);

    if (items.length === 0) {
      const fid = await getLatestFulfillmentId(order.id);
      if (fid) {
        await updateFulfillmentTracking(fid, tracking, tracking_url, CARRIER);
        await setOrderMetafield(order.id, label?.link);
        await swapTags(order.id);
        return new Response(JSON.stringify({
          ok: true,
          note: "updated-tracking-on-existing-fulfillment",
          order: order.name,
          tracking, tracking_url, label_url: label?.link ?? null,
        }), { status: 200 });
      }
      await setOrderMetafield(order.id, label?.link);
      await swapTags(order.id);
      return new Response(JSON.stringify({
        ok: true,
        note: "no-items-to-fulfill-and-no-fulfillment",
        order: order.name,
        label_url: label?.link ?? null,
      }), { status: 200 });
    }

    await createFulfillment(items, tracking, tracking_url, CARRIER);
    await setOrderMetafield(order.id, label?.link);
    await swapTags(order.id);

    return new Response(JSON.stringify({
      ok: true,
      order: order.name,
      tracking, tracking_url, label_url: label?.link ?? null,
    }), { status: 200 });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), { status: 500 });
  }
}
