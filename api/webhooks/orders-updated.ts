// api/webhooks/orders-updated.ts
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * ENV richieste:
 * - SPRO_API_BASE=https://www.spedirepro.com/public-api/v1
 * - SPRO_API_TOKEN=<X-Api-Key SpedirePro>
 * - SPRO_TRIGGER_TAG=SPRO-CREATE
 * - SPRO_WEBHOOK_TOKEN=<opzionale>
 */
const SPRO_BASE = (process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1").replace(/\/+$/, "");
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || "";
const TRIGGER_TAG = String(process.env.SPRO_TRIGGER_TAG || "SPRO-CREATE").toLowerCase();
const INBOUND_TOKEN = process.env.SPRO_WEBHOOK_TOKEN || "";

/* Tipi Shopify minimi */
type ShopifyAddress = {
  first_name?: string; last_name?: string; name?: string;
  address1?: string; address2?: string; city?: string; province?: string;
  zip?: string; country?: string; phone?: string;
};
type ShopifyOrder = {
  id: number; name: string; tags?: string; email?: string; total_weight?: number;
  line_items: Array<{ id:number; title:string; quantity:number; grams:number; sku?:string; product_type?:string; price:string; name?:string; }>;
  shipping_address?: ShopifyAddress;
};

/* Util */
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
  const headers={ "Content-Type":"application/json", "Accept":"application/json", "X-Api-Key":SPRO_TOKEN, ...(init.headers||{}) };
  const res=await fetch(url,{...init,headers});
  const text=await res.text().catch(()=> "");
  if(!res.ok){ console.error(`[SPRO] ${path} -> ${res.status} ${res.statusText} ${text?.slice(0,300)}`); throw new Error(`SPRO ${path} failed: ${res.status}`); }
