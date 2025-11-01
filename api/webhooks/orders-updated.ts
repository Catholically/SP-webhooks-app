// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || ""; // "Bearer xxx"
const [DEF_L, DEF_WD, DEF_H] = (process.env.DEFAULT_DIM_CM || "20x12x5").split("x").map(Number);
const DEF_WEIGHT = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

const jget = (o:any,p:(string|number)[])=>p.reduce((a,k)=>a&&typeof a==="object"?a[k]:undefined,o);

async function readBody(req: NextRequest){
  const enc = req.headers.get("content-encoding");
  try {
    if (enc === "gzip") {
      const ab = await req.arrayBuffer();
      const ds = new DecompressionStream("gzip");
      const decompressed = new Response(new Blob([ab]).stream().pipeThrough(ds));
      return JSON.parse(await decompressed.text());
    }
    return await req.json();
  } catch (e:any) {
    console.warn("orders-updated: invalid-json", String(e?.message||e));
    return null;
  }
}

async function gql(query: string, variables?: Record<string, any>) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await res.text();
  let json:any; try{ json = JSON.parse(text); } catch {}
  if (!res.ok || json?.errors) return { ok:false, status:res.status, json, text };
  return { ok:true, json };
}

function hasTag(input:any, tag:string){
  if (!input) return false;
  if (Array.isArray(input)) return input.includes(tag);
  if (typeof input === "string") return input.split(",").map(s=>s.trim()).includes(tag);
  return false;
}

// Normalize address coming from REST or GraphQL
function normalizeAddress(a:any){
  if (!a) return null;
  const country =
    a.countryCodeV2 || a.country_code || a.country_code_v2 ||
    (typeof a.country === "string" && a.country.length === 2 ? a.country : null);
  const province =
    a.provinceCode || a.province_code || a.province || null;

  const out = {
    name: a.name || [a.first_name, a.last_name].filter(Boolean).join(" ") || "Customer",
    address1: a.address1,
    address2: a.address2 || "",
    city: a.city,
    province,
    zip: a.zip || a.postal_code || a.postcode,
    country,
    phone: a.phone || "",
    email: a.email || "",
  };

  if (!out.address1 || !out.city || !out.zip || !out.country) return null;
  return out;
}

async function sproCreateLabel(payload:any){
  if (!SPRO_TOKEN) {
    console.warn("orders-updated: SPRO_API_TOKEN missing, skip create-label");
    return { ok:false, status:0, json:null, text:"missing SPRO_API_TOKEN" };
  }
  const res = await fetch(`${SPRO_BASE}/create-label`, {
    method: "POST",
    headers: { Authorization: SPRO_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json:any; try{ json = JSON.parse(text); } catch {}
  if (!res.ok) return { ok:false, status: res.status, json, text };
  return { ok:true, status: res.status, json, text };
}

export default async function handler(req: NextRequest){
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok:false, error:"method-not-allowed" }), { status:405 });
  }

  const raw:any = await readBody(req);
  if (!raw) return new Response(JSON.stringify({ ok:true, skipped:"invalid-json" }), { status:200 });

  const orderName = raw?.name || (raw?.order_number ? `#${raw.order_number}` : null);
  const orderGid  = raw?.admin_graphql_api_id || null;
  const tags      = raw?.tags ?? raw?.tag_string;

  // 1) trigger
  if (!hasTag(tags, "SPRO-CREATE")) {
    return new Response(JSON.stringify({ ok:true, skipped:"no-SPRO-CREATE" }), { status:200 });
  }

  // 2) address from REST
  let ship = normalizeAddress(raw?.shipping_address);

  // 3) if missing, fetch via GraphQL
  if (!ship && orderGid) {
    const q = `query($id:ID!){
      order(id:$id){
        shippingAddress{ name address1 address2 city province provinceCode zip countryCodeV2 phone }
        email
      }
    }`;
    const r = await gql(q, { id: orderGid });
    if (r.ok) {
      const g = jget(r.json, ["data","order","shippingAddress"]) || {};
      g.email = jget(r.json, ["data","order","email"]) || "";
      ship = normalizeAddress(g);
    }
  }

  if (!ship) {
    console.warn("orders-updated: missing-shipping-address-normalized", { order: orderName });
    return new Response(JSON.stringify({ ok:true, skipped:"no-shipping-address" }), { status:200 });
  }

  const payload = {
    merchant_reference: orderName || "UNKNOWN",
    to: {
      name: ship.name,
      address1: ship.address1,
      address2: ship.address2,
      city: ship.city,
      province: ship.province || "",
      zip: ship.zip,
      country: ship.country,
      phone: ship.phone,
      email: ship.email,
    },
    parcel: {
      length_cm: Number.isFinite(DEF_L) ? DEF_L : 20,
      width_cm:  Number.isFinite(DEF_WD) ? DEF_WD : 12,
      height_cm: Number.isFinite(DEF_H) ? DEF_H : 5,
      weight_kg: Number.isFinite(DEF_WEIGHT) ? DEF_WEIGHT : 0.5,
    },
  };

  const sp = await sproCreateLabel(payload);
  if (sp.ok && orderGid) {
    // salva reference se presente
    const ref = jget(sp.json,["reference"]) || jget(sp.json,["data","reference"]) || null;
    if (ref) {
      const m = `mutation($metafields:[MetafieldsSetInput!]!){
        metafieldsSet(metafields:$metafields){ userErrors{ message } }
      }`;
      const metafields = [{ ownerId: orderGid, namespace:"spro", key:"reference", type:"single_line_text_field", value:String(ref) }];
      await gql(m, { metafields });
    }
    // tag swap
    const m2 = `mutation($id:ID!){
      add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
      rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
    }`;
    await gql(m2, { id: orderGid });
  }

  return new Response(JSON.stringify({
    ok:true,
    note: sp.ok ? "label-requested" : "label-request-failed",
    status: sp.status || 0,
    order: orderName
  }), { status:200 });
}
