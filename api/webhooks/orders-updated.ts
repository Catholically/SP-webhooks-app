// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

// ===== Config =====
const SHOP  = process.env.SHOPIFY_SHOP || "";
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

// SpedirePro: host e path fissi come richiesto
const SPRO_BASE  = "https://www.spedirepro.com";
const SPRO_PATH  = "/public-api/v1/create-label";
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || ""; // usato in X-Api-Key

const DEFAULT_PARCEL_CM = process.env.DEFAULT_PARCEL_CM || "20x12x5";
const DEFAULT_WEIGHT_KG = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

// === helpers base ===
function j(status:number, data:any){
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type":"application/json" }
  });
}
const ok  = (d:any={}) => j(200, { ok:true,  ...d });
const out = (d:any={}) => j(200, { ok:false, ...d }); // mai 4xx verso Shopify

async function bodyJson(req: NextRequest){ try { return await req.json(); } catch { return null; } }

// === Shopify ===
function shopHeaders(){
  return {
    "X-Shopify-Access-Token": TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}
async function shop(path:string, init?:RequestInit){
  const url = `https://${SHOP}/admin/api/${API_VERSION}${path}`;
  const res = await fetch(url, { ...init, headers: { ...shopHeaders(), ...(init?.headers||{}) } });
  const text = await res.text().catch(()=> "");
  if (!res.ok) throw new Error(`shopify ${path} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
function hasTag(tags: string[]|string|undefined, tag:string){
  if (!tags) return false;
  if (Array.isArray(tags)) return tags.some(t => String(t).trim().toLowerCase() === tag.toLowerCase());
  return String(tags).split(",").map(s=>s.trim().toLowerCase()).includes(tag.toLowerCase());
}
function parseDims(cm:string){
  const a = cm.toLowerCase().split("x").map(n=>Number(n.trim()));
  return a.length===3 && a.every(n=>isFinite(n)&&n>0) ? a as [number,number,number] : [20,12,5];
}
function sumWeightKg(order:any){
  if (order?.line_items?.length){
    const g = order.line_items.reduce((acc:number,it:any)=>acc + Number(it.grams||0)*Number(it.quantity||1),0);
    if (g>0) return g/1000;
  }
  return DEFAULT_WEIGHT_KG;
}
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

// === SpedirePro ===
function sproHeaders(){
  return {
    "X-Api-Key": SPRO_TOKEN,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
}
async function sproCreateLabel(payload:any){
  const url = `${SPRO_BASE}${SPRO_PATH}`;
  const res = await fetch(url, { method:"POST", headers: sproHeaders(), body: JSON.stringify(payload) });
  const text = await res.text().catch(()=> "");
  let json:any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    console.log("orders-updated: SpedirePro error", { status: res.status, url, body: json });
    throw new Error(`SPRO ${res.status}: ${text}`);
  }
  return json; // atteso: { reference: "..." }
}

// === Metafield + tag ===
async function writeOrderMetafield(orderId:number, namespace:string, key:string, value:string){
  const body = { metafield: { namespace, key, type:"single_line_text_field", value } };
  return await shop(`/orders/${orderId}/metafields.json`, { method:"POST", body: JSON.stringify(body) });
}
async function replaceTag(orderId:number, removeTag:string, addTag:string){
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

// === Main ===
export default async function handler(req: NextRequest){
  if (!SHOP || !TOKEN) return out({ error:"missing-shopify-env" });
  if (!SPRO_TOKEN)     return out({ error:"missing-spro-token" });

  const ev = await bodyJson(req);
  if (!ev) return out({ error:"invalid-json" });

  const order = ev.order || ev;
  const orderId = Number(order?.id || 0) || undefined;
  const name = order?.name || null;
  if (!orderId) return out({ error:"missing-order-id" });

  const tags = order?.tags || (Array.isArray(order?.current_tags) ? order.current_tags.join(",") : "");
  if (!hasTag(tags, "SPRO-CREATE")) return ok({ skipped:true, reason:"tag-missing-SPRO-CREATE", order:name });

  const [L,W,H] = parseDims(DEFAULT_PARCEL_CM);
  const weightKg = sumWeightKg(order);
  const to = shipTo(order);

  // Schema /create-label: receiver + parcel
  const payload = {
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
        address:  to.address.address
      }
    },
    parcel: {
      weight_kg: weightKg,
      length_cm: L,
      width_cm:  W,
      height_cm: H
    }
  };

  try {
    const rsp = await sproCreateLabel(payload); // { reference }
    const reference = rsp?.reference || null;

    if (reference) {
      try { await writeOrderMetafield(orderId, "shipping", "spedirepro_reference", String(reference)); } catch {}
      try { await replaceTag(orderId, "SPRO-CREATE", "SPRO-PENDING"); } catch {}
    }

    return ok({ status:"reference-created", order:name, reference });
  } catch (e:any) {
    return out({ error:"spro-create-label-failed", message:String(e?.message||e), order:name, endpoint:`${SPRO_BASE}${SPRO_PATH}` });
  }
}
