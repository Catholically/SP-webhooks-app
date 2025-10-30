// api/webhooks/orders-updated.ts
import type { NextApiRequest, NextApiResponse } from "next";

/** ENV
 * SPRO_API_BASE=https://www.spedirepro.com/public-api/v1
 * SPRO_API_TOKEN=<X-Api-Key SpedirePro>
 * SPRO_TRIGGER_TAG=SPRO-CREATE
 * SHOPIFY_SHOP=<mystore.myshopify.com>
 * SHOPIFY_ACCESS_TOKEN=<Admin API token>
 */
const SPRO_BASE = (process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1").replace(/\/+$/,"");
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || "";
const TRIGGER_TAG = String(process.env.SPRO_TRIGGER_TAG || "SPRO-CREATE").toLowerCase();

const SHOP = String(process.env.SHOPIFY_SHOP || "");
const SHOP_TOKEN = String(process.env.SHOPIFY_ACCESS_TOKEN || "");
const API_VER = "2024-10";

// default pacco
const DEF_WIDTH_CM = 20;
const DEF_HEIGHT_CM = 12;
const DEF_DEPTH_CM = 5;
const DEF_MIN_WEIGHT_KG = 0.5;

// tipi minimi
type ShopifyAddress = {
  first_name?: string; last_name?: string; name?: string;
  address1?: string; address2?: string; city?: string; province?: string; province_code?: string;
  zip?: string; country?: string; country_code?: string; phone?: string;
};
type LineItem = { id:number; title:string; quantity:number; grams:number; sku?:string; product_type?:string; price:string; name?:string; };
type ShopifyOrder = { id:number; name:string; tags?:string; email?:string; total_weight?:number; line_items: LineItem[]; shipping_address?: ShopifyAddress; };

// util
function hasTriggerTag(tags?: string){ return Boolean(tags?.split(",").map(t=>t.trim().toLowerCase()).includes(TRIGGER_TAG)); }
function gramsToKg(g?: number){ return +((Math.max(0, g||0))/1000).toFixed(3); }
function selectItems(o:ShopifyOrder){
  const EX_TYPES=new Set(["ups","insurance"]); const EX_NAMES=new Set(["tip"]);
  return o.line_items.filter(li=>{
    const pt=(li.product_type||"").toLowerCase().trim();
    const nm=(li.name||li.title||"").toLowerCase().trim();
    return !EX_TYPES.has(pt) && !EX_NAMES.has(nm);
  });
}
async function shopifyAdmin(path:string, init:RequestInit={}){
  if(!SHOP || !SHOP_TOKEN) throw new Error("Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN");
  const url = `https://${SHOP}/admin/api/${API_VER}${path.startsWith("/")?"":"/"}${path}`;
  const headers = { "X-Shopify-Access-Token": SHOP_TOKEN, "Content-Type":"application/json", Accept:"application/json", ...(init.headers||{}) };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text().catch(()=> "");
  if(!res.ok){ console.error(`[SHOPIFY] ${path} -> ${res.status} ${res.statusText} ${text?.slice(0,300)}`); throw new Error(`SHOPIFY ${path} failed: ${res.status}`); }
  return text ? JSON.parse(text) : {};
}
async function sproFetch<T=any>(path:string, init:RequestInit={}):Promise<T>{
  if(!SPRO_TOKEN) throw new Error("Missing SPRO_API_TOKEN");
  const url=`${SPRO_BASE}${path.startsWith("/")?"":"/"}${path}`;
  const headers={ "Content-Type":"application/json", Accept:"application/json", "X-Api-Key":SPRO_TOKEN, ...(init.headers||{}) };
  const res=await fetch(url,{...init,headers});
  const text=await res.text().catch(()=> "");
  if(!res.ok){
    let detail:any={}; try{ detail=JSON.parse(text);}catch{}
    const msg = detail?.error?.message || detail?.message || res.statusText;
    const code = detail?.error?.code || detail?.code || res.status;
    console.error(`[SPRO] ${path} -> ${res.status} ${msg} (code:${code})`);
    if (String(code)==="1011" || /credit/i.test(String(msg))) { const e:any=new Error("SPRO_NO_CREDITS"); e.code=1011; e.detail=detail; throw e; }
    throw new Error(`SPRO ${path} failed: ${res.status}`);
  }
  try{ return JSON.parse(text) as T; }catch{ /* @ts-ignore */ return text as T; }
}

// country map -> ISO2
const countryMap: Record<string,string> = {
  italy:"IT","united states":"US",usa:"US",france:"FR",germany:"DE",spain:"ES",
  canada:"CA",poland:"PL",portugal:"PT",switzerland:"CH","united kingdom":"GB"
};
function normalizeCountry(a: ShopifyAddress){
  const c=(a.country_code||a.country||"").trim();
  if(c.length===2) return c.toUpperCase();
  return (countryMap[c.toLowerCase()] || "US");
}

// province US/CA
const US_STATE: Record<string,string> = {
  "alabama":"AL","al":"AL","alaska":"AK","ak":"AK","arizona":"AZ","az":"AZ","california":"CA","ca":"CA",
  "colorado":"CO","co":"CO","connecticut":"CT","ct":"CT","delaware":"DE","de":"DE","florida":"FL","fl":"FL",
  "georgia":"GA","ga":"GA","hawaii":"HI","hi":"HI","idaho":"ID","id":"ID","illinois":"IL","il":"IL",
  "indiana":"IN","in":"IN","iowa":"IA","ia":"IA","kansas":"KS","ks":"KS","kentucky":"KY","ky":"KY",
  "louisiana":"LA","la":"LA","maine":"ME","me":"ME","maryland":"MD","md":"MD","massachusetts":"MA","ma":"MA",
  "michigan":"MI","mi":"MI","minnesota":"MN","mn":"MN","mississippi":"MS","ms":"MS","missouri":"MO","mo":"MO",
  "montana":"MT","mt":"MT","nebraska":"NE","ne":"NE","nevada":"NV","nv":"NV","new hampshire":"NH","nh":"NH",
  "new jersey":"NJ","nj":"NJ","new mexico":"NM","nm":"NM","new york":"NY","ny":"NY","north carolina":"NC","nc":"NC",
  "north dakota":"ND","nd":"ND","ohio":"OH","oh":"OH","oklahoma":"OK","ok":"OK","oregon":"OR","or":"OR",
  "pennsylvania":"PA","pa":"PA","rhode island":"RI","ri":"RI","south carolina":"SC","sc":"SC",
  "south dakota":"SD","sd":"SD","tennessee":"TN","tn":"TN","texas":"TX","tx":"TX","utah":"UT","ut":"UT",
  "vermont":"VT","vt":"VT","virginia":"VA","va":"VA","washington":"WA","wa":"WA","west virginia":"WV","wv":"WV",
  "wisconsin":"WI","wi":"WI","wyoming":"WY","wy":"WY","district of columbia":"DC","dc":"DC"
};
const CA_PROV: Record<string,string> = {
  "alberta":"AB","ab":"AB","british columbia":"BC","bc":"BC","manitoba":"MB","mb":"MB","new brunswick":"NB","nb":"NB",
  "newfoundland and labrador":"NL","nl":"NL","nova scotia":"NS","ns":"NS","ontario":"ON","on":"ON",
  "prince edward island":"PE","pe":"PE","quebec":"QC","qc":"QC","saskatchewan":"SK","sk":"SK",
  "northwest territories":"NT","nt":"NT","nunavut":"NU","nu":"NU","yukon":"YT","yt":"YT"
};
function normalizeProvince(country2: string, province?: string, province_code?: string) {
  if (province_code && province_code.length <= 3) return province_code.toUpperCase();
  const p = String(province || "").trim();
  if (!p) return "";
  if (country2 === "US") return US_STATE[p.toLowerCase()] || (p.length === 2 ? p.toUpperCase() : p);
  if (country2 === "CA") return CA_PROV[p.toLowerCase()] || (p.length === 2 ? p.toUpperCase() : p);
  return p.length <= 3 ? p.toUpperCase() : p;
}

function requireShippingAddress(order: ShopifyOrder){
  const a=order.shipping_address;
  return Boolean(a && (a.address1 || a.city || a.zip || a.country || a.country_code));
}

// metafield + tag
async function getSproOrderIdMetafield(orderId:number){
  const mf = await shopifyAdmin(`/orders/${orderId}/metafields.json?namespace=spro&key=order_id`, { method:"GET" });
  const list = Array.isArray(mf?.metafields) ? mf.metafields : [];
  const m = list.find((x:any)=> x.namespace==="spro" && x.key==="order_id");
  return m?.value ? String(m.value) : "";
}
async function setSproOrderIdMetafield(orderId:number, value:string){
  return shopifyAdmin(`/orders/${orderId}/metafields.json`, {
    method:"POST",
    body: JSON.stringify({ metafield:{ namespace:"spro", key:"order_id", type:"single_line_text_field", value } })
  });
}
function retag(tags:string, toRemove:string, toAdd:string){
  const cur = new Set(String(tags||"").split(",").map(t=>t.trim()).filter(Boolean));
  if (toRemove) cur.delete(toRemove);
  if (toAdd) cur.add(toAdd);
  return Array.from(cur).join(", ");
}
async function updateOrderTags(orderId:number, newTags:string){
  return shopifyAdmin(`/orders/${orderId}.json`, { method:"PUT", body: JSON.stringify({ order:{ id: orderId, tags: newTags } }) });
}

// payload
function buildCreateLabelPayload(order: ShopifyOrder){
  const addr = order.shipping_address || {};
  const items = selectItems(order);

  const totalGrams = items.reduce((s,li)=> s + (Number(li.grams||0)*Number(li.quantity||0)),0);
  const weightKg = Math.max(gramsToKg(totalGrams || order.total_weight || 0), DEF_MIN_WEIGHT_KG);

  const receiver_name = addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(" ").trim() || "Customer";
  const country2 = normalizeCountry(addr);
  const province2 = normalizeProvince(country2, addr.province, addr.province_code);

  return {
    merchant_reference: order.name,
    include_return_label: false,
    courier_fallback: true,
    book_pickup: false,
    sender: {
      name: "Catholically",
      street: "Via di Porta Angelica 23",
      city: "Roma",
      province: "RM",
      postcode: "00193",
      country: "IT",
      phone: "+3906123456",
      email: "info@catholically.com",
    },
    receiver: {
      name: receiver_name,
      street: addr.address1 || "",
      street2: addr.address2 || "",
      city: addr.city || "",
      province: province2,
      postcode: addr.zip || "",
      country: country2,
      phone: addr.phone || "",
      email: order.email || "",
    },
    packages: [{ width: DEF_WIDTH_CM, height: DEF_HEIGHT_CM, depth: DEF_DEPTH_CM, weight: weightKg }],
    parcel: { weight: weightKg },
    contents: items.map(li=>({
      description: li.title,
      quantity: li.quantity,
      sku: li.sku || String(li.id),
      unit_price: Number(li.price || 0),
      weight: gramsToKg((li.grams||0) * (li.quantity||0)),
    })),
  };
}

// handler
export default async function handler(req:NextApiRequest,res:NextApiResponse){
  if(req.method!=="POST"){ res.status(405).json({ok:false,error:"Method not allowed"}); return; }

  console.log("[ORD-UPD] hit");

  try{
    const order = req.body as ShopifyOrder;
    console.log("[ORD-UPD] body", { id: order?.id, name: order?.name, tags: order?.tags });

    if(!order?.id){ res.status(200).json({ok:true,skipped:"no-order"}); return; }
    if(!hasTriggerTag(order.tags)){ res.status(200).json({ok:true,skipped:"no-trigger-tag"}); return; }
    if(!requireShippingAddress(order)){ console.error("[ORD-UPD] skipped: no-shipping-address",{id:order.id,name:order.name}); res.status(200).json({ok:true,skipped:"no-shipping-address"}); return; }

    const existing = await getSproOrderIdMetafield(order.id);
    if (existing) {
      const newTags = retag(order.tags||"", "SPRO-CREATE", "SPRO-SENT");
      if (newTags !== (order.tags||"")) await updateOrderTags(order.id, newTags);
      res.status(200).json({ ok:true, skipped:"already-created", order_id: existing });
      return;
    }

    const payload = buildCreateLabelPayload(order);
    console.log("[SPRO] payload", {
      ref: payload.merchant_reference,
      to_country: payload.receiver.country,
      province: payload.receiver.province,
      pkg: payload.packages[0]
    });

    let created:any;
    try{
      created = await sproFetch<any>("/create-label",{ method:"POST", body: JSON.stringify(payload) });
    }catch(e:any){
      if (e?.code===1011 || e?.message==="SPRO_NO_CREDITS"){
        const newTags = retag(order.tags||"", "SPRO-CREATE", "SPRO-FAILED");
        if (newTags !== (order.tags||"")) await updateOrderTags(order.id, newTags);
        res.status(200).json({ ok:false, skipped:"no-credits" }); return;
      }
      throw e;
    }

    const sproOrderId = typeof created === "string" ? created : (created?.order || created?.id || "");
    console.log("[SPRO] create-label response", sproOrderId);

    if(sproOrderId){
      await setSproOrderIdMetafield(order.id, sproOrderId);
      const newTags = retag(order.tags||"", "SPRO-CREATE", "SPRO-SENT");
      if (newTags !== (order.tags||"")) await updateOrderTags(order.id, newTags);
    }

    res.status(200).json({ ok:true, order_id: sproOrderId });
  }catch(err:any){
    console.error("[ORD-UPD] error", err);
    res.status(500).json({ok:false,error:String(err?.message||err)});
  }
}
