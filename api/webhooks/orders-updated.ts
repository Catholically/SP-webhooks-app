// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE = process.env.SPRO_API_BASE!;
const SPRO_TOKEN = process.env.SPRO_API_TOKEN!;
const DEF_DIM = (process.env.DEFAULT_DIM_CM || "20x12x5").split("x").map(Number);
const DEF_W = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

const pick = (o:any,p:(string|number)[])=>p.reduce((a,k)=>a&&typeof a==="object"?a[k]:undefined,o);

async function shopifyGQL(q:string, v?:Record<string,any>) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, variables: v||{} }),
  });
  const t = await r.text(); let j:any; try{ j=JSON.parse(t);}catch{}
  if (!r.ok || j?.errors) return { ok:false, status:r.status, j, t };
  return { ok:true, j };
}

function hasTag(tags:any, tag:string){ 
  if (Array.isArray(tags)) return tags.includes(tag);
  if (typeof tags === "string") return tags.split(",").map(s=>s.trim()).includes(tag);
  return false;
}

async function sproCreateLabel(payload:{
  merchant_reference:string;
  to:{ name:string; address1:string; address2?:string; city:string; province?:string; zip:string; country:string; phone?:string; email?:string; };
  parcel:{ length_cm:number; width_cm:number; height_cm:number; weight_kg:number; };
}) {
  const url = `${SPRO_BASE}/create-label`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": SPRO_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json:any; try{ json = JSON.parse(text);}catch{}
  return { ok: res.ok, status: res.status, json, text };
}

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") return new Response(JSON.stringify({ ok:false, error:"method-not-allowed" }), { status:405 });

  // Shopify Order Updated webhook REST payload
  let body:any; try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok:false, error:"invalid-json" }), { status:400 }); }

  const name = body?.name || body?.order_number ? `#${body.order_number}` : undefined;
  const gid  = body?.admin_graphql_api_id;

  // Leggi tag correnti
  const tags = body?.tags ?? body?.tag_string;
  if (!hasTag(tags, "SPRO-CREATE")) {
    return new Response(JSON.stringify({ ok:true, skipped:"no-SPRO-CREATE" }), { status:200 });
  }

  // Prendi indirizzo di spedizione dal payload o da GQL se manca
  let ship = body?.shipping_address;
  if (!ship && gid) {
    const q = `query($id:ID!){ order(id:$id){ name shippingAddress{
      name address1 address2 city province zip countryCodeV2 phone
    } } }`;
    const r = await shopifyGQL(q,{ id: gid });
    if (!r.ok) return new Response(JSON.stringify({ ok:false, step:"fetch-order-addr", shopify_error:r.j||r.t }), { status:500 });
    ship = {
      name: pick(r.j,["data","order","shippingAddress","name"]),
      address1: pick(r.j,["data","order","shippingAddress","address1"]),
      address2: pick(r.j,["data","order","shippingAddress","address2"]),
      city: pick(r.j,["data","order","shippingAddress","city"]),
      province: pick(r.j,["data","order","shippingAddress","province"]),
      zip: pick(r.j,["data","order","shippingAddress","zip"]),
      country: pick(r.j,["data","order","shippingAddress","countryCodeV2"]),
      phone: pick(r.j,["data","order","shippingAddress","phone"]),
    };
  }
  if (!ship?.address1 || !ship?.city || !ship?.zip || !ship?.country) {
    return new Response(JSON.stringify({ ok:false, step:"missing-address", ship }), { status:400 });
  }

  const [L,W,H] = DEF_DIM;
  const payload = {
    merchant_reference: name || body?.name || "UNKNOWN",
    to: {
      name: ship.name || `${body?.shipping_first_name||""} ${body?.shipping_last_name||""}`.trim() || "Customer",
      address1: ship.address1,
      address2: ship.address2 || "",
      city: ship.city,
      province: ship.province || "",
      zip: ship.zip,
      country: ship.country,
      phone: ship.phone || body?.phone || "",
      email: body?.email || "",
    },
    parcel: { length_cm: L||20, width_cm: W||12, height_cm: H||5, weight_kg: isFinite(DEF_W)?DEF_W:0.5 },
  };

  const sp = await sproCreateLabel(payload);
  if (!sp.ok) return new Response(JSON.stringify({ ok:false, step:"spro-create-label", status:sp.status, body: sp.json||sp.text }), { status:502 });

  // Swap tag: SPRO-CREATE -> SPRO-SENT
  if (gid) {
    const m = `
      mutation($id:ID!){
        add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
        rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
      }`;
    const r = await shopifyGQL(m, { id: gid });
    if (!r.ok) return new Response(JSON.stringify({ ok:false, step:"swap-tags", shopify_error:r.j||r.t }), { status:500 });
  }

  return new Response(JSON.stringify({ ok:true, note:"label-requested", order: name || body?.name, spro_response: sp.json||null }), { status:200 });
}
