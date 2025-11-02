// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

// ===== Config =====
const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

// SpedirePro
const SPRO_BASE      = (process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1").replace(/\/+$/,"");
const SPRO_TOKEN_RAW = process.env.SPRO_API_TOKEN || ""; // header X-Api-Key
const SPRO_CREATE_PATH = "/create-label";                 // per your docs

// Defaults
const DEFAULT_PARCEL_CM = process.env.DEFAULT_PARCEL_CM || "20x12x5";
const DEFAULT_WEIGHT_KG = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

function j(status:number, data:any){ return new Response(JSON.stringify(data), { status, headers:{"content-type":"application/json"} }); }
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
function parseDims(cm: string){ const a=cm.toLowerCase().split("x").map(n=>Number(n.trim())); return a.length===3 && a.every(n=>isFinite(n)&&n>0)? a as [number,number,number]:[20,12,5]; }
function sumWeightKg(order:any){ if (order?.line_items?.length){ const g = order.line_items.reduce((acc:number,it:any)=>acc + Number(it.grams||0)*Number(it.quantity||1),0); if (g>0) return g/1000; } return DEFAULT_WEIGHT_KG; }
function shipTo(order:any){
  const a = order?.shipping_address || order?.customer?.default_address || {};
  return {
    first_name: a.first_name || order?.customer?.first_name || "",
    last_name:  a.last_name  || order?.customer?.last_name  || "",
    email:      order?.email || order?.customer?.email || "",
    phone:      a.phone || order?.phone || "",
    address: {
      country:  a.country_code || a.country || "",
      state:    a.province || a.province_code || "",
      city:     a.city || "",
      postcode: a.zip || "",
      address:  a.address1 || "",
      address2: a.address2 || "",
    },
  };
}

// ===== SpedirePro create-label =====
function sproHeaders() {
  return {
    "X-Api-Key": SPRO_TOKEN_RAW,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
}
async function sproCreateLabel(payload:any) {
  const url = `${SPRO_BASE}${SPRO_CREATE_PATH}`;
  const res = await fetch(url, { method:"POST", headers: sproHeaders(), body: JSON.stringify(payload) });
  const text = await res.text().catch(()=> "");
  let json:any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`SPRO create-label ${res.status}: ${text}`);
  return json; // docs: returns { reference: "..." } synchronously
}

// ===== Shopify helpers =====
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

// ===== Main =====
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
  const to = shipTo(order);

  // Payload per SpedirePro create-label docs
  const sproPayload = {
    merchant_reference: name,
    receiver: {
      first_name: to.first_name,
      last_name:  to.last_name,
      email:      to.email,
      address: {
        country:  to.address.country,
        state:    to.address.state,
        city:     to.address.city,
        postcode: to.address.postcode,
        address:  to.address.address,
      }
    },
    parcel: {
      weight_kg: weightKg,
      length_cm: L,
      width_cm:  W,
      height_cm: H
    }
  };

  let resp;
  try {
    resp = await sproCreateLabel(sproPayload); // expected: { reference: "..." }
  } catch (e:any) {
    return bad(401, "spro-unauthenticated-or-bad-request", { message: String(e?.message || e), order: name ?? null });
  }

  const reference = resp?.reference || null;

  // Save reference now. Label URL will arrive via webhook.
  if (reference) {
    try { await writeOrderMetafield(orderId, "shipping", "spedirepro_reference", String(reference)); } catch {}
  }

  // Move workflow to pending until webhook confirms label
  try { await replaceTag(orderId, "SPRO-CREATE", "SPRO-PENDING"); } catch {}

  return ok({
    status: "spro-reference-created",
    order: name ?? null,
    reference,
    note: "Label will be delivered asynchronously via webhook."
  });
}
