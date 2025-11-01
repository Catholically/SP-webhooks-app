// api/webhooks/spedirepro.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const HOOK_TOKEN = process.env.SPRO_WEBHOOK_TOKEN!;

async function readJson(req: NextRequest){ try { return await req.json(); } catch { return null; } }
function bad(code:number,msg:string,data?:any){ return new Response(JSON.stringify({ ok:false, error:msg, data }), { status:code }); }

async function shopifyGQL(query:string, variables?:Record<string,any>){
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type":"application/json" },
    body: JSON.stringify({ query, variables: variables||{} }),
  });
  const text = await res.text(); let json:any; try{ json=JSON.parse(text);}catch{}
  if (!res.ok || json?.errors) return { ok:false, status:res.status, json, text };
  return { ok:true, json };
}
async function shopifyREST(path:string, init?:RequestInit){
  const res = await fetch(`https://${SHOP}/admin/api/2025-10${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers||{})
    },
  });
  const text = await res.text();
  let json:any; try{ json=JSON.parse(text);}catch{}
  return { ok: res.ok, status: res.status, json, text };
}

// ---- find order by merchant_reference "#NNN" o numeric ID ----
async function findOrderByRef(ref:string){
  // 1) name:#NNN via GraphQL con status:any
  if (ref?.startsWith("#")){
    const q = `
      orders(first:1, query:$q) {
        edges {
          node {
            id
            name
            legacyResourceId
            displayFulfillmentStatus
            fulfillments(first:10){ id status trackingInfo{ number url } }
          }
        }
      }`;
    const r = await shopifyGQL(`query($q:String!){ ${q} }`, { q: `name:${ref} status:any` });
    if (r.ok && r.json?.data?.orders?.edges?.length){
      const node = r.json.data.orders.edges[0].node;
      return { id: node.id, legacyId: node.legacyResourceId, name: node.name, fulfillments: node.fulfillments||[], dfs: node.displayFulfillmentStatus };
    }
  }
  // 2) fallback: ID numerico
  const num = ref?.replace(/[^0-9]/g,"");
  if (num){
    const r = await shopifyGQL(`query($id:ID!){
      order(id:$id){
        id name legacyResourceId displayFulfillmentStatus
        fulfillments(first:10){ id status trackingInfo{ number url } }
      }
    }`, { id: `gid://shopify/Order/${num}` });
    if (r.ok && r.json?.data?.order){
      const n = r.json.data.order;
      return { id: n.id, legacyId: n.legacyResourceId, name: n.name, fulfillments: n.fulfillments||[], dfs: n.displayFulfillmentStatus };
    }
  }
  return null;
}

// ---- get open fulfillment_orders ----
async function getOpenFOs(orderLegacyId: string | number){
  const r = await shopifyREST(`/orders/${orderLegacyId}/fulfillment_orders.json`, { method:"GET" });
  if (!r.ok) return { ok:false, ...r };
  const all = (r.json?.fulfillment_orders||[]);
  const list = all.filter((fo:any)=> fo.status !== "closed" && fo.status !== "cancelled");
  console.log("FOs:", JSON.stringify(all.map((x:any)=>({id:x.id,status:x.status,assigned_location_id:x.assigned_location_id}))));
  return { ok:true, list, all };
}

// ---- create fulfillment from fulfillment_orders ----
async function createFulfillment(orderLegacyId: string | number, foList:any[], tracking:{ number?:string, url?:string, company?:string }){
  if (!foList?.length) return { ok:false, status:422, json:{ errors:["no-open-fulfillment-orders"] } };

  const line_items_by_fulfillment_order = foList.map((fo:any)=>({
    fulfillment_order_id: fo.id,
    fulfillment_order_line_items: (fo.fulfillment_order_line_items||[]).map((li:any)=>({
      id: li.id, quantity: li.quantity
    }))
  }));

  const body = {
    fulfillment: {
      notify_customer: false,
      tracking_info: {
        number: tracking.number || null,
        url: tracking.url || null,
        company: tracking.company || "UPS",
      },
      line_items_by_fulfillment_order
    }
  };

  return await shopifyREST(`/fulfillments.json`, { method:"POST", body: JSON.stringify(body) });
}

// ---- update tracking on existing fulfillment (REST) ----
async function updateTracking(orderLegacyId: string | number, fulfillmentId: string | number, tracking:{ number?:string, url?:string, company?:string }){
  const body = {
    fulfillment: {
      notify_customer: false,
      tracking_info: {
        number: tracking.number || null,
        url: tracking.url || null,
        company: tracking.company || "UPS",
      }
    }
  };
  return await shopifyREST(`/orders/${orderLegacyId}/fulfillments/${fulfillmentId}/update_tracking.json`, {
    method:"POST", body: JSON.stringify(body)
  });
}

// ---- set metafield label URL ----
async function setLabelMetafield(orderGid: string, labelUrl?:string, reference?:string){
  const metas:any[] = [];
  if (labelUrl) metas.push({ ownerId: orderGid, namespace:"spro", key:"label_url", type:"url", value:String(labelUrl) });
  if (reference) metas.push({ ownerId: orderGid, namespace:"spro", key:"reference", type:"single_line_text_field", value:String(reference) });
  if (!metas.length) return { ok:true };
  const m = `mutation($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){ userErrors{ message } }
  }`;
  return await shopifyGQL(m, { metafields: metas });
}

// ---- add tracking + label to order, create fulfillment if needed ----
async function applyTrackingAndLabel(order:{ id:string, legacyId:string|number, fulfillments:any[] }, trackingNum?:string, trackingUrl?:string, labelUrl?:string, reference?:string){
  // 1) se c'è già un fulfillment, aggiorna tracking
  const existing = order.fulfillments?.[0];
  if (existing){
    const fid = String(existing.id).split("/").pop()!;
    const r = await updateTracking(order.legacyId, fid, { number: trackingNum, url: trackingUrl, company: "UPS" });
    await setLabelMetafield(order.id, labelUrl, reference);
    return { step:"update-tracking", rest:r };
  }

  // 2) altrimenti crea fulfillment dai fulfillment_orders aperti
  const fos = await getOpenFOs(order.legacyId);
  if (!fos.ok) return { step:"fetch-fo-error", detail: fos };

  if (!fos.list.length){
    // NIENTE FO aperti: spieghiamo bene il perché (draft order, manual, già chiusi, location sbagliata, etc.)
    return { step:"no-open-fulfillment-orders", detail: { all: fos.all } };
  }

  const cr = await createFulfillment(order.legacyId, fos.list, { number: trackingNum, url: trackingUrl, company:"UPS" });
  await setLabelMetafield(order.id, labelUrl, reference);
  return { step:"create-fulfillment", rest: cr };
}

// =========================================================
export default async function handler(req: NextRequest){
  if (req.method !== "POST") return bad(405,"method-not-allowed");

  const token = new URL(req.url).searchParams.get("token") || "";
  if (!HOOK_TOKEN || token !== HOOK_TOKEN) return bad(401,"unauthorized");

  const body = await readJson(req);
  if (!body) return bad(400,"invalid-json");

  const merchantRef = body.merchant_reference || body.merchantRef;
  const reference   = body.reference || body.order;
  const trackingNum = body.tracking || body.tracking_number;
  const trackingUrl = body.tracking_url || (body.tracking && typeof body.tracking === "object" ? body.tracking.url : undefined);

  // supporto URL bridge/label o varianti
  const labelUrl =
    body.label?.link ||
    body.label_url ||
    body.labelUrl ||
    (typeof body.label === "string" && body.label.startsWith("http") ? body.label : undefined) ||
    (body.link && String(body.link).includes("spedirepro.com/bridge/label") ? body.link : undefined);

  console.log("spedirepro: incoming", { merchantRef, reference, trackingNum, trackingUrl, labelUrl });

  if (!merchantRef) return bad(400,"missing-merchant_reference");

  const order = await findOrderByRef(merchantRef);
  if (!order) return new Response(JSON.stringify({ ok:false, error:"order-not-found", ref: merchantRef }), { status:200 });

  const result = await applyTrackingAndLabel(order, trackingNum, trackingUrl, labelUrl, reference);

  // Risposta dettagliata per capire cosa succede
  return new Response(JSON.stringify({
    ok: true,
    order: order.name,
    displayFulfillmentStatus: order.dfs,
    step: result.step,
    detail: result.rest?.json || result.detail || null
  }), { status:200 });
}
