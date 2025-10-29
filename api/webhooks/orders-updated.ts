// api/webhooks/orders-updated.ts
import type { NextApiRequest, NextApiResponse } from "next";

/** ENV richieste
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

type ShopifyAddress = {
  first_name?: string; last_name?: string; name?: string;
  address1?: string; address2?: string; city?: string; province?: string;
  zip?: string; country?: string; country_code?: string; phone?: string;
};
type LineItem = { id:number; title:string; quantity:number; grams:number; sku?:string; product_type?:string; price:string; name?:string; };
type ShopifyOrder = {
  id: number; name: string; tags?: string; email?: string; total_weight?: number;
  line_items: Array<LineItem>;
  shipping_address?: ShopifyAddress;
};

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
async function sproFetch<T=any>(path:string, init:RequestInit={}):Promise<T>{
  if(!SPRO_TOKEN) throw new Error("Missing SPRO_API_TOKEN");
  const url=`${SPRO_BASE}${path.startsWith("/")?"":"/"}${path}`;
  const headers={ "Content-Type":"application/json", Accept:"application/json", "X-Api-Key":SPRO_TOKEN, ...(init.headers||{}) };
  const res=await fetch(url,{...init,headers});
  const text=await res.text().catch(()=> "");
  if(!res.ok){ console.error(`[SPRO] ${path} -> ${res.status} ${res.statusText} ${text?.slice(0,300)}`); throw new Error(`SPRO ${path} failed: ${res.status}`); }
  try{ return JSON.parse(text) as T; }catch{ /* @ts-ignore */ return text as T; }
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

// map nomi paese -> ISO2
const countryMap: Record<string,string> = {
  italy:"IT","united states":"US",usa:"US",france:"FR",germany:"DE",spain:"ES",
  canada:"CA",poland:"PL",portugal:"PT",switzerland:"CH","united kingdom":"GB"
};
function normalizeCountry(a: ShopifyAddress){
  const c=(a.country_code||a.country||"").trim();
  if(c.length===2) return c.toUpperCase();
  return (countryMap[c.toLowerCase()] || "US");
}

function requireShippingAddress(order: ShopifyOrder){
  const a=order.shipping_address;
  return Boolean(a && (a.address1 || a.city || a.zip || a.country || a.country_code));
}

function buildCreateLabelPayload(order: ShopifyOrder){
  const addr = order.shipping_address || {};
  const items = selectItems(order);
  const totalGrams = items.reduce((s,li)=> s + (Number(li.grams||0)*Number(li.quantity||0)),0);
  const weightKg = Math.max(gramsToKg(totalGrams || order.total_weight || 0), DEF_MIN_WEIGHT_KG);
  const receiver_name = addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(" ").trim() || "Customer";

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
      province: addr.province || "",
      postcode: addr.zip || "",
      country: normalizeCountry(addr),
      phone: addr.phone || "",
      email: order.email || "",
    },
    packages: [{ width:20, height:12, depth:5, weight: weightKg }],
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

export default async function handler(req:NextApiRequest,res:NextApiResponse){
  if(req.method!=="POST"){ res.status(405).json({ok:false,error:"Method not allowed"}); return; }

  try{
    const order = req.body as ShopifyOrder;
    if(!order?.id){ res.status(200).json({ok:true,skipped:"no-order"}); return; }
    if(!hasTriggerTag(order.tags)){ res.status(200).json({ok:true,skipped:"no-trigger-tag"}); return; }
    if(!requireShippingAddress(order)){ console.error("[ORD-UPD] skipped: no-shipping-address",{id:order.id,name:order.name}); res.status(200).json({ok:true,skipped:"no-shipping-address"}); return; }

    const payload = buildCreateLabelPayload(order);
    console.log("[SPRO] payload", { ref: payload.merchant_reference, to_country: payload.receiver.country, pkg: payload.packages[0] });

    // create label
    const created = await sproFetch<any>("/create-label",{ method:"POST", body: JSON.stringify(payload) });
    const sproOrderId = typeof created === "string" ? created : (created?.order || created?.id || "");
    console.log("[SPRO] order-id", sproOrderId);

    // salva metafield spro.order_id
    if(sproOrderId){
      await shopifyAdmin(`/orders/${order.id}/metafields.json`, {
        method: "POST",
        body: JSON.stringify({
          metafield: {
            namespace: "spro",
            key: "order_id",
            type: "single_line_text_field",
            value: sproOrderId
          }
        })
      });
    }

    res.status(200).json({ok:true, order_id: sproOrderId});
  }catch(err:any){
    res.status(500).json({ok:false,error:String(err?.message||err)});
  }
}
