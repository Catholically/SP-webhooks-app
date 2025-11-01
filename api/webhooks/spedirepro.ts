// api/webhooks/spedirepro.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const CARRIER = process.env.DEFAULT_CARRIER_NAME || "UPS";
const WEBHOOK_TOKEN = process.env.SPRO_WEBHOOK_TOKEN;
const SPRO_BASE = process.env.SPRO_API_BASE!;
const SPRO_TOKEN = process.env.SPRO_API_TOKEN!;

type SpPayload = {
  merchant_reference?: string;  // es. "#35558182025"
  reference?: string;           // riferimento SpedirePro
  tracking?: string;
  tracking_url?: string;
  label?: { link?: string; url?: string };
  label_url?: string;
  labelPdf?: string;
};

const jget = (o:any,p:(string|number)[])=>p.reduce((a,k)=>a&&typeof a==="object"?a[k]:undefined,o);

async function gql(q:string,v?:Record<string,any>) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method:"POST", headers:{ "X-Shopify-Access-Token":TOKEN, "Content-Type":"application/json" },
    body: JSON.stringify({ query:q, variables:v||{} })
  });
  const t = await r.text(); let j:any; try{ j=JSON.parse(t);}catch{}
  if (!r.ok || j?.errors) return { ok:false, status:r.status, t, j };
  return { ok:true, j };
}

function gidToNum(gid?:string){ if(!gid) return null; const m=gid.match(/\/(\d+)$/); return m?m[1]:null; }

async function findOrderByNameOrId(ref:string){
  const name = ref.startsWith("#") ? ref : `#${ref}`;
  const q = `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id name } } } }`;
  const r = await gql(q, { q:`status:any name:${JSON.stringify(name)}` });
  if (!r.ok) return { ok:false, err:r.j||r.t };
  const n = jget(r.j, ["data","orders","edges",0,"node"]);
  if (!n?.id) return { ok:false, nf:true };
  return { ok:true, order:n };
}

async function getOpenFOItems(orderId:string){
  const q = `query($id:ID!){
    order(id:$id){
      id
      fulfillmentOrders(first:20){
        edges{ node{
          id status
          lineItems(first:100){ edges{ node{ id remainingQuantity } } }
        } }
      }
    }
  }`;
  const r = await gql(q,{ id: orderId });
  if (!r.ok) return { ok:false, err:r.j||r.t };
  const edges = jget(r.j, ["data","order","fulfillmentOrders","edges"])||[];
  const items: { fulfillment_order_id:string; line_item_id:string; qty:number }[] = [];
  for (const e of edges){
    const status = jget(e,["node","status"]);
    if (status !== "OPEN" && status !== "IN_PROGRESS") continue;
    const foId = jget(e,["node","id"]);
    for (const le of jget(e,["node","lineItems","edges"])||[]){
      const liId = jget(le,["node","id"]);
      const rem = jget(le,["node","remainingQuantity"])||0;
      if (foId && liId && rem>0) items.push({ fulfillment_order_id: foId, line_item_id: liId, qty: rem });
    }
  }
  return { ok:true, items };
}

async function createFulfillmentREST(items:{fulfillment_order_id:string; line_item_id:string; qty:number}[], trackNo?:string, trackUrl?:string, company?:string){
  const groups: Record<string,{ fulfillment_order_id:string; fulfillment_order_line_items:{ id:string; quantity:number }[] }> = {};
  for (const it of items){
    const fo = gidToNum(it.fulfillment_order_id); const li = gidToNum(it.line_item_id);
    if (!fo || !li) continue;
    if (!groups[fo]) groups[fo] = { fulfillment_order_id: fo, fulfillment_order_line_items: [] };
    groups[fo].fulfillment_order_line_items.push({ id: li, quantity: it.qty });
  }
  const line_items_by_fulfillment_order = Object.values(groups);
  if (!line_items_by_fulfillment_order.length) return { ok:false, status:422, body:"no-open-fo-items" };

  const url = `https://${SHOP}/admin/api/2025-10/fulfillments.json`;
  const body = {
    fulfillment: {
      line_items_by_fulfillment_order,
      tracking_info: { number: trackNo||"", url: trackUrl||"", company: company||CARRIER },
      notify_customer: false,
    }
  };
  const res = await fetch(url, { method:"POST", headers:{ "X-Shopify-Access-Token":TOKEN, "Content-Type":"application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) return { ok:false, status:res.status, body:text };
  return { ok:true };
}

async function latestFulfillment(orderId:string){
  const q = `query($id:ID!){ order(id:$id){ fulfillments{ id createdAt } } }`;
  const r = await gql(q,{ id: orderId });
  if (!r.ok) return { ok:false, err:r.j||r.t };
  const list = jget(r.j, ["data","order","fulfillments"])||[];
  let latest:any=null; for (const f of list){ if (f?.id && f?.createdAt) if (!latest || new Date(f.createdAt)>new Date(latest.createdAt)) latest=f; }
  return { ok:true, id: latest?.id||null };
}

async function updateTrackingREST(fidGid:string, number?:string, url?:string, company?:string){
  const fid = gidToNum(fidGid); if (!fid) return { ok:false, status:0, body:"bad-fulfillment-id" };
  const endpoint = `https://${SHOP}/admin/api/2025-10/fulfillments/${fid}/update_tracking.json`;
  const body = { fulfillment:{ tracking_info:{ number:number||"", url:url||"", company:company||CARRIER }, notify_customer:false } };
  const res = await fetch(endpoint, { method:"POST", headers:{ "X-Shopify-Access-Token":TOKEN, "Content-Type":"application/json" }, body: JSON.stringify(body) });
  const text = await res.text(); if (!res.ok) return { ok:false, status:res.status, body:text };
  return { ok:true };
}

async function setLabelMetafields(orderGid:string, labelUrl?:string){
  if (!labelUrl) return { ok:true };
  const m = `mutation($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){ userErrors{ message } }
  }`;
  const metafields = [
    { ownerId: orderGid, namespace:"spro",   key:"label_url", type:"single_line_text_field", value: labelUrl },
    { ownerId: orderGid, namespace:"custom", key:"ups_label", type:"single_line_text_field", value: labelUrl },
  ];
  const r = await gql(m, { metafields });
  if (!r.ok) return { ok:false, err:r.j||r.t };
  return { ok:true };
}

async function swapTags(orderGid:string){
  const m = `mutation($id:ID!){
    add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
    rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
  }`;
  await gql(m,{ id: orderGid });
}

async function sproFetchLabel(reference?:string){
  if (!reference) return null;
  const res = await fetch(`${SPRO_BASE}/labels/${encodeURIComponent(reference)}`, {
    headers:{ Authorization: SPRO_TOKEN }
 
