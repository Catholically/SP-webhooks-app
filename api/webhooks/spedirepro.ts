// api/webhooks/spedirepro.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

/*
ENV richieste:
- SHOPIFY_SHOP
- SHOPIFY_ADMIN_TOKEN
- SPRO_API_BASE
- SPRO_API_TOKEN
- SPRO_WEBHOOK_TOKEN          (token nella query ?token=)
- UPS_LABEL_NS                default "spedirepro"
- UPS_LABEL_KEY               default "ldv_url"
*/

const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN_RAW = process.env.SPRO_API_TOKEN || "";
const WH_TOKEN = process.env.SPRO_WEBHOOK_TOKEN || "";
const LABEL_NS = process.env.UPS_LABEL_NS || "spedirepro";
const LABEL_KEY = process.env.UPS_LABEL_KEY || "ldv_url";

function sproAuthHeaders(){
  const hasBearer = /^bearer\s+/i.test(SPRO_TOKEN_RAW);
  const value = hasBearer ? SPRO_TOKEN_RAW : `Bearer ${SPRO_TOKEN_RAW}`;
  return {
    "X-Api-Key": value,
    "Authorization": value,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

async function ok(data:any){ return new Response(JSON.stringify({ ok:true, ...data }), { status:200 }); }
async function bad(code:number,msg:string){ return new Response(JSON.stringify({ ok:false, error:msg }), { status:code }); }

async function shopifyREST(path:string, init?:RequestInit){
  const res = await fetch(`https://${SHOP}/admin/api/2025-10${path}`, {
    ...init,
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type":"application/json", "Accept":"application/json", ...(init?.headers||{}) }
  });
  const text = await res.text();
  let json:any; try{ json=JSON.parse(text);}catch{}
  return { ok: res.ok, status: res.status, json, text };
}
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

async function findOrderByName(name:string){
  const q = `query($q:String!){ orders(first:1, query:$q){ nodes{ id legacyResourceId name } } }`;
  const r = await shopifyGQL(q, { q: `name:${name}` });
  const node = r.ok ? r.json?.data?.orders?.nodes?.[0] : null;
  return node ? { gid: node.id as string, id: Number(node.legacyResourceId) as number } : null;
}

async function setLabelMetafield(orderGid:string, url:string){
  const m = `mutation($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){ userErrors{ message } }
  }`;
  return await shopifyGQL(m, { metafields: [{ ownerId: orderGid, namespace: LABEL_NS, key: LABEL_KEY, type: "url", value: url }] });
}

async function createFulfillment(orderId:number, tracking:string, trackingUrl?:string){
  // REST create fulfillment minimal
  return await shopifyREST(`/orders/${orderId}/fulfillments.json`, {
    method: "POST",
    body: JSON.stringify({
      fulfillment: {
        tracking_company: "UPS",
        tracking_numbers: [tracking],
        tracking_urls: trackingUrl ? [trackingUrl] : [],
        notify_customer: false,
        line_items: undefined // auto su tutti gli articoli open
      }
    })
  });
}

function extract(body:any){
  return {
    merchantRef: body?.merchant_reference || body?.merchantRef || body?.merchant_reference_id || body?.name,
    reference: body?.reference || body?.order || body?.shipment || body?.shipment_number,
    tracking: body?.tracking || body?.tracking_number || body?.trackingNum,
    trackingUrl: body?.tracking_url || body?.trackingUrl,
    labelUrl: body?.label_url || body?.labelUrl || body?.label?.link || body?.link || body?.url
  };
}

export default async function handler(req: NextRequest){
  if (req.method !== "POST") return bad(405, "method-not-allowed");

  // token dalla query
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (!WH_TOKEN || token !== WH_TOKEN) return bad(401, "unauthorized");

  let body:any = null;
  try { body = await req.json(); } catch { return bad(400, "invalid-json"); }

  const { merchantRef, reference, tracking, trackingUrl, labelUrl } = extract(body);
  if (!merchantRef) return bad(400, "missing-merchant-reference");

  const ord = await findOrderByName(merchantRef);
  if (!ord) return bad(404, "order-not-found");

  // Metafield label se c'è
  if (labelUrl) { await setLabelMetafield(ord.gid, String(labelUrl)); }

  // Fulfillment + tracking se c'è
  if (tracking) { await createFulfillment(ord.id, String(tracking), trackingUrl || undefined); }

  return ok({
    received: true,
    order: merchantRef,
    reference: reference || null,
    tracking: tracking || null,
    tracking_url: trackingUrl || null,
    label_url: labelUrl || null
  });
}
