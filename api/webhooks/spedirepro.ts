// api/webhooks/spedirepro.ts
import type { NextApiRequest, NextApiResponse } from "next";

/** ENV richieste
 * SHOPIFY_SHOP=<mystore.myshopify.com>
 * SHOPIFY_ACCESS_TOKEN=<Admin API token>
 * SPRO_WEBHOOK_TOKEN=<facoltativo, token che SpedirePro invia in ?token=... o header X-Webhook-Token>
 */
const SHOP = String(process.env.SHOPIFY_SHOP || "");
const SHOP_TOKEN = String(process.env.SHOPIFY_ACCESS_TOKEN || "");
const API_VER = "2024-10";
const INBOUND_TOKEN = String(process.env.SPRO_WEBHOOK_TOKEN || "");

async function shopifyAdmin(path:string, init:RequestInit={}){
  if(!SHOP || !SHOP_TOKEN) throw new Error("Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN");
  const url = `https://${SHOP}/admin/api/${API_VER}${path.startsWith("/")?"":"/"}${path}`;
  const headers = { "X-Shopify-Access-Token": SHOP_TOKEN, "Content-Type":"application/json", Accept:"application/json", ...(init.headers||{}) };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text().catch(()=> "");
  if(!res.ok){ console.error(`[SHOPIFY] ${path} -> ${res.status} ${res.statusText} ${text?.slice(0,300)}`); throw new Error(`SHOPIFY ${path} failed: ${res.status}`); }
  return text ? JSON.parse(text) : {};
}

/** SpedirePro sample body tipico:
 * {
 *   "merchant_reference": "#1002",
 *   "reference": "251030C8T000131P",
 *   "tracking": "1Z....",
 *   "tracking_url": "https://...",
 *   "label": { "url": "https://...", "link": "https://..." }
 * }
 */
type SPROWebhook = {
  merchant_reference?: string;
  reference?: string;
  tracking?: string;
  tracking_url?: string;
  label?: { url?: string; link?: string; tracking_url?: string };
};

export default async function handler(req:NextApiRequest,res:NextApiResponse){
  if(req.method!=="POST"){ res.status(405).json({ok:false,error:"Method not allowed"}); return; }

  // opzionale: verifica token in query o header
  if(INBOUND_TOKEN){
    const q = String(req.query?.token || "");
    const h = String(req.headers["x-webhook-token"] || "");
    if((q && q!==INBOUND_TOKEN) && (h && h!==INBOUND_TOKEN)){
      res.status(401).json({ok:false,error:"unauthorized"}); return;
    }
  }

  try{
    const w = req.body as SPROWebhook;
    const orderName = String(w.merchant_reference || "").trim();
    if(!orderName){ res.status(400).json({ok:false,error:"missing merchant_reference"}); return; }

    // trova ordine per name
    const search = await shopifyAdmin(`/orders.json?name=${encodeURIComponent(orderName)}`, { method:"GET" });
    const order = Array.isArray(search?.orders) ? search.orders[0] : undefined;
    if(!order?.id){ res.status(200).json({ok:true,skipped:"order-not-found", name: orderName}); return; }

    const trackingNumber = String(w.tracking || "").trim();
    const trackingUrl =
      String(w.tracking_url || w.label?.tracking_url || w.label?.link || "").trim();
    const labelUrl = String(w.label?.url || w.label?.link || "").trim();

    // crea fulfillment con tracking se presente
    if(trackingNumber || trackingUrl){
      await shopifyAdmin(`/fulfillments.json`, {
        method: "POST",
        body: JSON.stringify({
          fulfillment: {
            order_id: order.id,
            notify_customer: true,
            tracking_number: trackingNumber || undefined,
            tracking_url: trackingUrl || undefined
          }
        })
      });
    }

    // salva metafield con label url se presente
    if(labelUrl){
      await shopifyAdmin(`/orders/${order.id}/metafields.json`, {
        method: "POST",
        body: JSON.stringify({
          metafield: {
            namespace: "shipping",
            key: "label_url",
            type: "single_line_text_field",
            value: labelUrl
          }
        })
      });
    }

    // salva anche spro.order_id se non presente
    if(w.reference){
      await shopifyAdmin(`/orders/${order.id}/metafields.json`, {
        method: "POST",
        body: JSON.stringify({
          metafield: {
            namespace: "spro",
            key: "order_id",
            type: "single_line_text_field",
            value: String(w.reference)
          }
        })
      });
    }

    res.status(200).json({ok:true, order_id: order.id});
  }catch(err:any){
    res.status(500).json({ok:false,error:String(err?.message||err)});
  }
}
