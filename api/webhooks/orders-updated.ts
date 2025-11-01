// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE = process.env.SPRO_API_BASE!;
const SPRO_TOKEN = process.env.SPRO_API_TOKEN!;
const [DEF_L, DEF_WD, DEF_H] = (process.env.DEFAULT_DIM_CM || "20x12x5").split("x").map(Number);
const DEF_WEIGHT = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

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

function hasTag(input:any, tag:string) {
  if (Array.isArray(input)) return input.includes(tag);
  if (typeof input === "string") return input.split(",").map(s=>s.trim()).includes(tag);
  return false;
}

async function sproCreateLabel(payload:any){
  const res = await fetch(`${SPRO_BASE}/create-label`, {
    method:"POST",
    headers:{ Authorization: SPRO_TOKEN, "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text(); let json:any; try{ json=JSON.parse(text);}catch{}
  return { ok: res.ok, status: res.status, json, text };
}

export default async function handler(req: NextRequest){
  if (req.method !== "POST") return new Response(JSON.stringify({ ok:false, error:"method-not-allowed" }), { status:405 });

  let body:any; try{ body = await req.json(); }catch{ return new Response(JSON.stringify({ ok:false, error:"invalid-json" }), { status:400 }); }
  const orderName = body?.name || (body?.order_number ? `#${body.order_number}` : undefined);
  const gid = body?.admin_graphql_api_id;
  const tags = body?.tags ?? body?.tag_string;

  if (!hasTag(tags, "SPRO-CREATE")) {
    return new Response(JSON.stringify({ ok:true, skipped:"no-SPRO-CREATE" }), { status:200 });
  }

  // shipping address
  let ship = body?.shipping_address;
  if (!ship && gid) {
    const q = `query($id:ID!){ order(id:$id){ shippingAddress{ name address1 address2 city province zip countryCodeV2 phone } } }`;
    const r = await gql(q, { id: gid });
    if (!r.ok) return new Response(JSON.stringify({ ok:false, step:"fetch-addr", err:r.j||r.t }), { status:500 });
    ship = jget(r.j, ["data","order","shippingAddress"]);
  }
  if (!ship?.address1 || !ship?.city || !ship?.zip || !ship?.countryCodeV2) {
    return new Response(JSON.stringify({ ok:false, step:"missing-address", ship }), { status:400 });
  }

  const payload = {
    merchant_reference: orderName || "UNKNOWN",
    to: {
      name: ship.name || "Customer",
      address1: ship.address1,
      address2: ship.address2 || "",
      city: ship.city,
      province: ship.province || "",
      zip: ship.zip,
      country: ship.countryCodeV2,
      phone: ship.phone || body?.phone || "",
      email: body?.email || "",
    },
    parcel: { length_cm: DEF_L||20, width_cm: DEF_WD||12, height_cm: DEF_H||5, weight_kg: isFinite(DEF_WEIGHT)?DEF_WEIGHT:0.5 },
  };

  // chiamata SpedirePro
  const sp = await sproCreateLabel(payload);
  if (!sp.ok) return new Response(JSON.stringify({ ok:false, step:"spro-create-label", status:sp.status, body: sp.json||sp.text }), { status:502 });

  // salva reference SpedirePro per correlazione callback
  if (gid) {
    const ref = jget(sp.json, ["reference"]) || jget(sp.json, ["data","reference"]) || null;
    if (ref) {
      const m = `mutation($metafields:[MetafieldsSetInput!]!){
        metafieldsSet(metafields:$metafields){ userErrors{ message } }
      }`;
      const metafields = [{ ownerId: gid, namespace:"spro", key:"reference", type:"single_line_text_field", value:String(ref) }];
      await gql(m, { metafields });
    }
    // swap tag
    const m2 = `mutation($id:ID!){
      add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
      rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
    }`;
    await gql(m2, { id: gid });
  }

  return new Response(JSON.stringify({ ok:true, note:"label-requested", order: orderName, spro: sp.json||null }), { status:200 });
}
