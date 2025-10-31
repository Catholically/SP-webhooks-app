// api/webhooks/spedirepro.ts
// Next.js Edge runtime
// ENV richieste:
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

// --------- Helper GQL con debug non distruttivo ---------

type GQLResult = {
  ok: boolean;
  status: number;
  json?: any;
  text?: string;
  error?: string;
};

async function shopifyGraphQLSafe(query: string, variables?: Record<string, any>): Promise<GQLResult> {
  try {
    const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json: any = undefined;
    try { json = JSON.parse(text); } catch { /* può non essere JSON */ }
    if (!res.ok) {
      return { ok: false, status: res.status, text, error: `HTTP ${res.status}` };
    }
    if (json?.errors?.length) {
      return { ok: false, status: res.status, json, text, error: json.errors.map((e: any) => e.message).join("; ") };
    }
    return { ok: true, status: res.status, json, text };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message ?? e) };
  }
}

const pick = (o: any, path: string[]): any =>
  path.reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), o);

// --------- Funzioni di dominio sicure ---------

function normalizeRef(refRaw: string) {
  const ref = (refRaw || "").trim();
  const hasHash = ref.startsWith("#");
  const name = ref.replace(/^#/, "");
  const numericId = /^\d+$/.test(ref) ? ref : undefined;
  const nameWithHash = hasHash ? ref : `#${name}`;
  return { name, nameWithHash, numericId };
}

async function findOrderByRef(merchantRef: string): Promise<
  | { ok: true; order: { id: string; name: string } }
  | { ok: false; step: string; shopify_error?: any }
  | { ok: false; not_found: true }
> {
  const { name, nameWithHash, numericId } = normalizeRef(merchantRef);

  // 1) lookup diretto per ID numerico
  if (numericId) {
    const gid = `gid://shopify/Order/${numericId}`;
    const q = `query($id: ID!){ order(id:$id){ id name } }`;
    const r = await shopifyGraphQLSafe(q, { id: gid });
    if (!r.ok) return { ok: false, step: "order-by-id", shopify_error: r.json ?? r.text ?? r.error };
    const node = pick(r.json, ["data", "order"]);
    if (node?.id) return { ok: true, order: node };
  }

  // helper search
  const qSearch = `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id name } } } }`;
  async function searchBy(term: string, label: string) {
    const queryStr = `status:any name:${JSON.stringify(term)}`;
    const r = await shopifyGraphQLSafe(qSearch, { q: queryStr });
    if (!r.ok) return { err: { step: label, shopify_error: r.json ?? r.text ?? r.error } };
    const node = pick(r.json, ["data", "orders", "edges", 0, "node"]);
    return { node };
  }

  // 2) con hash
  {
    const { node, err } = await searchBy(nameWithHash, "order-search-hash");
    if (err) return { ok: false, step: err.step, shopify_error: err.shopify_error };
    if (node?.id) return { ok: true, order: node };
  }

  // 3) senza hash
  {
    const { node, err } = await searchBy(name, "order-search-plain");
    if (err) return { ok: false, step: err.step, shopify_error: err.shopify_error };
    if (node?.id) return { ok: true, order: node };
  }

  return { ok: false, not_found: true };
}

async function getFulfillmentOrderLineItems(orderId: string): Promise<
  | { ok: true; items: { fulfillmentOrderId: string; lineItemId: string; qty: number }[] }
  | { ok: false; step: string; shopify_error?: any }
> {
  const q = `
    query($id:ID!){
      order(id:$id){
        id
        fulfillmentOrders(first:10){
          edges{
            node{
              id
              lineItems(first:100){
                edges{ node{ id remainingQuantity } }
              }
            }
          }
        }
      }
    }`;
  const r = await shopifyGraphQLSafe(q, { id: orderId });
  if (!r.ok) return { ok: false, step: "fetch-fulfillment-orders", shopify_error: r.json ?? r.text ?? r.error };
  const order = pick(r.json, ["data", "order"]);
  if (!order?.id) {
    return { ok: false, step: "fetch-fulfillment-orders", shopify_error: "order null in GQL data" };
  }
  const edges = pick(order, ["fulfillmentOrders", "edges"]) || [];
  const items: { fulfillmentOrderId: string; lineItemId: string; qty: number }[] = [];
  for (const e of edges) {
    const foId = pick(e, ["node", "id"]);
    const liEdges = pick(e, ["node", "lineItems", "edges"]) || [];
    for (const le of liEdges) {
      const liId = pick(le, ["node", "id"]);
      const rem = pick(le, ["node", "remainingQuantity"]) ?? 0;
      if (foId && liId && rem > 0) items.push({ fulfillmentOrderId: foId, lineItemId: liId, qty: rem });
    }
  }
  return { ok: true, items };
}

async function createFulfillment(
  items: { fulfillmentOrderId: string; lineItemId: string; qty: number }[],
  trackingNumber: string | undefined,
  trackingUrl: string | undefined,
  trackingCompany: string,
): Promise<{ ok: true; fulfillmentId: string | null } | { ok: false; step: string; shopify_error?: any }> {
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
  const r = await shopifyGraphQLSafe(m, { input });
  if (!r.ok) return { ok: false, step: "fulfillment-create", shopify_error: r.json ?? r.text ?? r.error };
  const errs = pick(r.json, ["data", "fulfillmentCreateV2", "userErrors"]) || [];
  if (errs.length) return { ok: false, step: "fulfillment-create", shopify_error: errs };
  const fid = pick(r.json, ["data", "fulfillmentCreateV2", "fulfillment", "id"]) ?? null;
  return { ok: true, fulfillmentId: fid };
}

async function setOrderMetafield(orderId: string, labelUrl?: string): Promise<
  { ok: true } | { ok: false; step: string; shopify_error?: any }
> {
  if (!labelUrl) return { ok: true };
  const m = `
    mutation($metafields:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$metafields){ userErrors{ message } }
    }`;
  const metafields = [{
    ownerId: orderId, namespace: "spro", key: "label_url",
    type: "single_line_text_field", value: labelUrl,
  }];
  const r = await shopifyGraphQLSafe(m, { metafields });
  if (!r.ok) return { ok: false, step: "metafields-set", shopify_error: r.json ?? r.text ?? r.error };
  const errs = pick(r.json, ["data", "metafieldsSet", "userErrors"]) || [];
  if (errs.length) return { ok: false, step: "metafields-set", shopify_error: errs };
  return { ok: true };
}

async function swapTags(orderId: string): Promise<{ ok: true } | { ok: false; step: string; shopify_error?: any }> {
  const m = `
    mutation($id:ID!){
      add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
      rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
    }`;
  const r = await shopifyGraphQLSafe(m, { id: orderId });
  if (!r.ok) return { ok: false, step: "tags", shopify_error: r.json ?? r.text ?? r.error };
  const addErrs = pick(r.json, ["data", "add", "userErrors"]) || [];
  const remErrs = pick(r.json, ["data", "rem", "userErrors"]) || [];
  const errs = [...addErrs, ...remErrs];
  if (errs.length) return { ok: false, step: "tags", shopify_error: errs };
  return { ok: true };
}

async function getLatestFulfillmentId(orderId: string): Promise<
  { ok: true; fulfillmentId: string | null } | { ok: false; step: string; shopify_error?: any }
> {
  const q = `
    query($id:ID!){
      order(id:$id){
        fulfillments(first:10, reverse:true){ edges{ node{ id } } }
      }
    }`;
  const r = await shopifyGraphQLSafe(q, { id: orderId });
  if (!r.ok) return { ok: false, step: "fetch-fulfillments", shopify_error: r.json ?? r.text ?? r.error };
  const fid = pick(r.json, ["data", "order", "fulfillments", "edges", 0, "node", "id"]) ?? null;
  return { ok: true, fulfillmentId: fid };
}

async function updateFulfillmentTracking(
  fulfillmentId: string,
  trackingNumber: string | undefined,
  trackingUrl: string | undefined,
  trackingCompany: string,
): Promise<{ ok: true } | { ok: false; step: string; shopify_error?: any }> {
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
  const r = await shopifyGraphQLSafe(m, vars);
  if (!r.ok) return { ok: false, step: "tracking-update", shopify_error: r.json ?? r.text ?? r.error };
  const errs = pick(r.json, ["data", "fulfillmentTrackingInfoUpdateV2", "userErrors"]) || [];
  if (errs.length) return { ok: false, step: "tracking-update", shopify_error: errs };
  return { ok: true };
}

// --------- Handler ---------

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

  // 1) trova ordine
  const fnd = await findOrderByRef(merchant_reference);
  if (!("ok" in fnd) || fnd.ok === false) {
    if ("not_found" in fnd) {
      return new Response(JSON.stringify({ ok: true, skipped: "order-not-found", ref: merchant_reference }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, step: fnd.step, shopify_error: fnd.shopify_error }), { status: 500 });
  }
  const order = fnd.order;

  // 2) FO e linee rimanenti
  const gli = await getFulfillmentOrderLineItems(order.id);
  if (!gli.ok) {
    return new Response(JSON.stringify({ ok: false, step: gli.step, shopify_error: gli.shopify_error }), { status: 500 });
  }

  // 3) se non ci sono quantità, prova update tracking su fulfillment esistente
  if (gli.items.length === 0) {
    const gfid = await getLatestFulfillmentId(order.id);
    if (!gfid.ok) {
      return new Response(JSON.stringify({ ok: false, step: gfid.step, shopify_error: gfid.shopify_error }), { status: 500 });
    }
    if (gfid.fulfillmentId) {
      const up = await updateFulfillmentTracking(gfid.fulfillmentId, tracking, tracking_url, CARRIER);
      if (!up.ok) {
        return new Response(JSON.stringify({ ok: false, step: up.step, shopify_error: up.shopify_error }), { status: 500 });
      }
      const mf = await setOrderMetafield(order.id, label?.link);
      if (!mf.ok) return new Response(JSON.stringify({ ok: false, step: mf.step, shopify_error: mf.shopify_error }), { status: 500 });
      const tg = await swapTags(order.id);
      if (!tg.ok) return new Response(JSON.stringify({ ok: false, step: tg.step, shopify_error: tg.shopify_error }), { status: 500 });

      return new Response(JSON.stringify({
        ok: true,
        note: "updated-tracking-on-existing-fulfillment",
        order: order.name,
        tracking, tracking_url, label_url: label?.link ?? null,
      }), { status: 200 });
    }

    // nessun fulfillment: solo metafield + tag
    const mf = await setOrderMetafield(order.id, label?.link);
    if (!mf.ok) return new Response(JSON.stringify({ ok: false, step: mf.step, shopify_error: mf.shopify_error }), { status: 500 });
    const tg = await swapTags(order.id);
    if (!tg.ok) return new Response(JSON.stringify({ ok: false, step: tg.step, shopify_error: tg.shopify_error }), { status: 500 });

    return new Response(JSON.stringify({
      ok: true,
      note: "no-items-to-fulfill-and-no-fulfillment",
      order: order.name,
      label_url: label?.link ?? null,
    }), { status: 200 });
  }

  // 4) quantità presenti: crea fulfillment
  const cf = await createFulfillment(gli.items, tracking, tracking_url, CARRIER);
  if (!cf.ok) return new Response(JSON.stringify({ ok: false, step: cf.step, shopify_error: cf.shopify_error }), { status: 500 });

  const mf = await setOrderMetafield(order.id, label?.link);
  if (!mf.ok) return new Response(JSON.stringify({ ok: false, step: mf.step, shopify_error: mf.shopify_error }), { status: 500 });
  const tg = await swapTags(order.id);
  if (!tg.ok) return new Response(JSON.stringify({ ok: false, step: tg.step, shopify_error: tg.shopify_error }), { status: 500 });

  return new Response(JSON.stringify({
    ok: true,
    order: order.name,
    tracking, tracking_url, label_url: label?.link ?? null,
  }), { status: 200 });
}
