// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

// ===== Config =====
const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;

// SpedirePro
const SPRO_BASE       = (process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1").replace(/\/+$/,"");
const SPRO_TOKEN_RAW  = process.env.SPRO_API_TOKEN || "";      // your token from SpedirePro (X-Api-Key)
const SPRO_CREATE_PATH= process.env.SPRO_CREATE_PATH || "/spedizioni";
const API_VERSION     = process.env.SHOPIFY_API_VERSION || "2025-10";

const DEFAULT_PARCEL_CM   = process.env.DEFAULT_PARCEL_CM || "20x12x5";
const DEFAULT_WEIGHT_KG   = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");
const SPRO_SERVICE        = process.env.SPRO_SERVICE || "";

function j(status:number, data:any){ 
  return new Response(JSON.stringify(data), { 
    status, 
    headers:{"content-type":"application/json"} 
  }); 
}
const ok  = (d:any={}) => j(200, { ok:true, ...d });
const bad = (s:number,e:string,x?:any)=> j(s, { ok:false, error:e, ...(x??{}) });

async function bodyJson(req: NextRequest){ try{ return await req.json(); } catch{ return null; } }

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

function hasTag(tags: string[]|string|undefined, tag: string): boolean {
  if (!tags) return false;
  if (Array.isArray(tags)) return tags.some(t => String(t).trim().toLowerCase() === tag.toLowerCase());
  return String(tags).split(",").map(s=>s.trim().toLowerCase()).includes(tag.toLowerCase());
}

function parseDims(cm: string){ 
  const a=cm.toLowerCase().split("x").map(n=>Number(n.trim())); 
  return a.length===3 && a.every(n=>isFinite(n)&&n>0)? a as [number,number,number]:[20,12,5]; 
}

function sumWeightKg(order:any){ 
  if (order?.line_items?.length){ 
    const g = order.line_items.reduce((acc:number,it:any)=>acc + Number(it.grams||0)*Number(it.quantity||1),0); 
    if (g>0) return g/1000; 
  } 
  return DEFAULT_WEIGHT_KG; 
}

function shipToFrom(order:any){
  const a = order?.shipping_address || order?.customer?.default_address || {};
  return {
    first_name: a.first_name || order?.customer?.first_name || "",
    last_name:  a.last_name  || order?.customer?.last_name  || "",
    company:    a.company || "",
    address1:   a.address1 || "",
    address2:   a.address2 || "",
    city:       a.city || "",
    province:   a.province || a.province_code || "",
    zip:        a.zip || "",
    country:    a.country_code || a.country || "",
    phone:      a.phone || order?.phone || "",
    email:      order?.email || order?.customer?.email || "",
  };
}

// ==== SPEDIREPRO ====

function sproHeaders() {
  // SpedirePro uses only X-Api-Key for auth
  return {
    "X-Api-Key": SPRO_TOKEN_RAW,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
}

async function sproCreate(payload:any) {
  const urls = [
    `${SPRO_BASE}${SPRO_CREATE_PATH}`,
    `${SPRO_BASE}/create-label`,
    `${SPRO_BASE}/labels`,
  ];
  let lastErr:any = null;
  for (const url of urls) {
    const res = await fetch(url, { method:"POST", headers: sproHeaders(), body: JSON.stringify(payload) });
    const text = await res.text().catch(()=> "");
    let json:any = null; 
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (res.ok) return { ok:true, url, json, status:res.status };
    lastErr = { url, status: res.status, body: json };
    if (![401,404].includes(res.status)) break;
  }
  throw new Error(`SPRO create failed: ${JSON.stringify(lastErr)}`);
}

// ==== Shopify helpers ====

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

async function writeOrderMetafield(orderId:number, namespace:string, key:string, value:string) {
  const body = { metafield: { namespace, key, type:"single_line_text_field", value } };
  return await shop(`/orders/${orderId}/metafields.json`, { method:"POST", body: JSON.stringify(body) });
}

async function replaceTag(orderId:number, removeTag:string, addTag:string) {
  const res = await shop(`/orders/${orderId}.json`, { method:"GET" });
  const tagsStr: string = res?.order?.tags || "";
  const set = new Set(tagsStr.split(",").map((s:string)=>s.trim()).filter(Boolean));
  if (removeTag) set.delete(removeTag);
  if (addTag) set.add(addTag);
  const newTags = Array.from(set).join(", ");
  const body = { order: { id: orderId, tags: newTags } };
  await shop(`/orders/${orderId}.json`, { method:"PUT", body: JSON.stringify(body) });
  return { ok:true, tags:newTags };
}

// ==== Main ====

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") return bad(405, "method-not-allowed");
  if (!SHOP || !TOKEN) return bad(500, "missing-shopify-env");
  if (!SPRO_TOKEN_RAW) return bad(500, "missing-spro-token");

  const ev = await bodyJson(req);
  if (!ev) return bad(400, "invalid-json");

  const order = ev.order || ev;
  const orderId: number | undefined = Number(order?.id || 0) || undefined;
  const name: string | undefined = order?.name;
  if (!orderId) return bad(400, "missing-order-id");

  const tags = order?.tags || (Array.isArray(order?.current_tags) ? order.current_tags.join(",") : "");
  if (!hasTag(tags, "SPRO-CREATE")) return ok({ skipped:true, reason:"tag-missing-SPRO-CREATE", order: name ?? null });

  const [L,W,H] = parseDims(DEFAULT_PARCEL_CM);
  const weightKg = sumWeightKg(order);
  const to = shipToFrom(order);

  const from = {
    name:    process.env.SPRO_SHIPPER_NAME   || "",
    address: process.env.SPRO_SHIPPER_ADDRESS|| "",
    city:    process.env.SPRO_SHIPPER_CITY   || "",
    zip:     process.env.SPRO_SHIPPER_ZIP    || "",
    country: process.env.SPRO_SHIPPER_COUNTRY|| "IT",
    phone:   process.env.SPRO_SHIPPER_PHONE  || "",
    email:   process.env.SPRO_SHIPPER_EMAIL  || "",
  };

  const sproPayload = {
    merchant_reference: name,
    service: SPRO_SERVICE || undefined,
    shipper: from,
    recipient: {
      name: `${to.first_name} ${to.last_name}`.trim(),
      company: to.company || undefined,
      address1: to.address1,
      address2: to.address2 || undefined,
      city: to.city,
      province: to.province || undefined,
      zip: to.zip,
      country: to.country,
      phone: to.phone || undefined,
      email: to.email || undefined,
    },
    parcels: [{ weight_kg: weightKg, length_cm: L, width_cm: W, height_cm: H }],
  };

  let created;
  try {
    created = await sproCreate(sproPayload);
  } catch (e:any) {
    return bad(401, "spro-unauthenticated", { message: String(e?.message || e), order: name ?? null });
  }

  const data = created?.json ?? {};
  const reference   = data.reference || data.id || data.data?.reference || null;
  const tracking    = data.tracking || data.tracking_number || data.data?.tracking_number || null;
  const trackingUrl = data.tracking_url || data.data?.tracking_url || null;
  const labelUrl    = data.label_url || data.label?.url || data.label?.link || data.data?.label_url || null;

  try {
    await createFulfillment(orderId, tracking, trackingUrl);
  } catch (e:any) {
    return bad(502, "shopify-fulfillment-failed", { message: String(e?.message || e), reference, tracking, tracking_url: trackingUrl, label_url: labelUrl });
  }

  if (labelUrl) {
    try { await writeOrderMetafield(orderId, "shipping", "spedirepro_label_url", String(labelUrl)); } catch {}
  }
  try { await replaceTag(orderId, "SPRO-CREATE", "SPRO-SENT"); } catch {}

  return ok({
    status: "spro-label-created",
    order: name ?? null,
    reference: reference ?? null,
    tracking: tracking ?? null,
    tracking_url: trackingUrl ?? null,
    label_url: labelUrl ?? null,
    endpoint_used: created?.url ?? null,
  });
}

