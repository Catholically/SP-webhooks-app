// api/webhooks/spedirepro.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

function json(status: number, data: any) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
const ok  = (d:any={}) => json(200, { ok:true, ...d });
const bad = (s:number,e:string,x?:any)=> json(s, { ok:false, error:e, ...(x??{}) });

async function parseBody(req: NextRequest) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) return await req.json();
    if (ct.includes("application/x-www-form-urlencoded")) {
      const raw = await req.text();
      const params = new URLSearchParams(raw);
      const obj: Record<string,string> = {};
      for (const [k,v] of params.entries()) obj[k]=v;
      if (obj.payload) { try { return JSON.parse(obj.payload); } catch { return obj; } }
      return obj;
    }
    const raw = await req.text();
    try { return JSON.parse(raw); } catch { return { raw }; }
  } catch { return null; }
}

const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

function shopHeaders() {
  return {
    "X-Shopify-Access-Token": TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}
async function shop(path: string, init?: RequestInit) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}${path}`;
  const res = await fetch(url, { ...init, headers: { ...shopHeaders(), ...(init?.headers||{}) } });
  const text = await res.text().catch(()=> "");
  if (!res.ok) throw new Error(`shopify ${path} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function writeMetafield(orderId:number, namespace:string, key:string, value:string) {
  const body = { metafield: { namespace, key, type:"single_line_text_field", value } };
  return await shop(`/orders/${orderId}/metafields.json`, { method:"POST", body: JSON.stringify(body) });
}
async function createFulfillment(orderId:number, trackingNumber:string|null, trackingUrl:string|null) {
  const body = {
    fulfillment: {
      notify_customer: false,
      tracking_numbers: trackingNumber ? [trackingNumber] : [],
      tracking_urls: trackingUrl ? [trackingUrl] : [],
      line_items_by_fulfillment_order: [],
    }
  };
  return await shop(`/orders/${orderId}/fulfillments.json`, { method:"POST", body: JSON.stringify(body) });
}
async function retag(orderId:number, fromTag:string, toTag:string) {
  const res = await shop(`/orders/${orderId}.json`, { method:"GET" });
  const tagsStr: string = res?.order?.tags || "";
  const set = new Set(tagsStr.split(",").map((s:string)=>s.trim()).filter(Boolean));
  if (fromTag) set.delete(fromTag);
  if (toTag) set.add(toTag);
  const newTags = Array.from(set).join(", ");
  const body = { order: { id: orderId, tags: newTags } };
  await shop(`/orders/${orderId}.json`, { method:"PUT", body: JSON.stringify(body) });
  return { ok:true, tags:newTags };
}

// Simple extractor
const pick = (...v:any[]) => v.find(x => x !== undefined && x !== null && x !== "");
function extract(b:any){
  const merchant_reference = pick(b.merchant_reference, b.order_name, b.order, b.name);
  const reference = pick(b.reference, b.ref, b.id);
  const tracking  = pick(b.tracking, b.tracking_number);
  const tracking_url = pick(b.tracking_url, b.tracking_link);
  const label_url = pick(b.label?.link, b.label?.url, b.label_url);
  const order_id = b.order_id || null; // if you send it back
  return { merchant_reference, reference, tracking, tracking_url, label_url, order_id };
}

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") return bad(405, "method-not-allowed");

  const expected = process.env.SPRO_WEBHOOK_TOKEN || "";
  if (!expected) return bad(500, "missing-env-SPRO_WEBHOOK_TOKEN");
  const provided = new URL(req.url).searchParams.get("token") || req.headers.get("x-webhook-token") || "";
  if (provided !== expected) return bad(401, "invalid-token");

  const body = await parseBody(req);
  if (!body) return ok({ skipped:true, reason:"empty-payload" });

  const ex = extract(body);
  console.log("SpedirePro webhook:", ex);

  // If label_url present, write metafield
  if (ex.label_url && ex.merchant_reference) {
    // Derive order ID by name
    try {
      const search = await shop(`/orders.json?name=${encodeURIComponent(ex.merchant_reference)}`, { method:"GET" });
      const order = Array.isArray(search?.orders) ? search.orders[0] : null;
      if (order?.id) {
        const orderId = Number(order.id);
        try { await writeMetafield(orderId, "shipping", "spedirepro_label_url", String(ex.label_url)); } catch {}
        // Optional fulfillment if tracking present
        if (ex.tracking || ex.tracking_url) {
          try { await createFulfillment(orderId, ex.tracking || null, ex.tracking_url || null); } catch {}
        }
        try { await retag(orderId, "SPRO-PENDING", "SPRO-SENT"); } catch {}
        return ok({ received:true, order: ex.merchant_reference, updated:true });
      }
    } catch(e:any) {
      return ok({ received:true, order_lookup:false, error:String(e?.message||e) });
    }
  }

  return ok({ received:true, reference: ex.reference || null });
}
