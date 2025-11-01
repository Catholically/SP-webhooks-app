// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;

const SPRO_BASE  = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || ""; // deve iniziare con "Bearer "

// Mittente di default per SpedirePro (ENV consigliate)
const FROM_NAME    = process.env.SPRO_FROM_NAME    || "Catholically";
const FROM_ADDR1   = process.env.SPRO_FROM_ADDR1   || "Via di Roma";
const FROM_ADDR2   = process.env.SPRO_FROM_ADDR2   || "";
const FROM_CITY    = process.env.SPRO_FROM_CITY    || "Roma";
const FROM_PROV    = process.env.SPRO_FROM_PROV    || "RM";
const FROM_ZIP     = process.env.SPRO_FROM_ZIP     || "00100";
const FROM_COUNTRY = process.env.SPRO_FROM_COUNTRY || "IT"; // ISO2
const FROM_PHONE   = process.env.SPRO_FROM_PHONE   || "+39000000000";
const FROM_EMAIL   = process.env.SPRO_FROM_EMAIL   || "support@catholically.com";

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
  } catch { return null; }
}

async function gql(query: string, variables?: Record<string, any>) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await res.text(); let json:any; try{ json = JSON.parse(text);}catch{}
  if (!res.ok || json?.errors) return { ok:false, status:res.status, json, text };
  return { ok:true, json };
}

function hasTag(input:any, tag:string){
  if (!input) return false;
  if (Array.isArray(input)) return input.includes(tag);
  if (typeof input === "string") return input.split(",").map(s=>s.trim()).includes(tag);
  return false;
}

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
  if (!SPRO_TOKEN || !SPRO_TOKEN.startsWith("Bearer ")) {
    console.error("SPRO_API_TOKEN mancante o senza 'Bearer '");
    return { ok:false, status:0, text:"missing-or-bad-token" };
  }
  const res = await fetch(`${SPRO_BASE}/create-label`, {
    method: "POST",
    headers: { Authorization: SPRO_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  // Log sintetico della risposta per debug
  console.log("spro-create-label: status", res.status, "body", text.slice(0,500));
  if (!res.ok) return { ok:false, status:res.status, text };
  let json:any; try{ json = JSON.parse(text);}catch{}
  return { ok:true, status:res.status, text, json };
}

export default async function handler(req: NextRequest){
  if (req.method !== "POST") return new Response(JSON.stringify({ ok:false, error:"method-not-allowed" }), { status:405 });

  const raw:any = await readBody(req);
  if (!raw) return new Response(JSON.stringify({ ok:true, skipped:"invalid-json" }), { status:200 });

  const orderName = raw?.name || (raw?.order_number ? `#${raw.order_number}` : null);
  const orderGid  = raw?.admin_graphql_api_id || null;
  const tags      = raw?.tags ?? raw?.tag_string;

  if (!hasTag(tags, "SPRO-CREATE")) {
    return new Response(JSON.stringify({ ok:true, skipped:"no-SPRO-CREATE" }), { status:200 });
  }

  // REST shipping → billing
  let ship = normalizeAddress(raw?.shipping_address);
  if (!ship) {
    const billingRest = raw?.billing_address ? { ...raw.billing_address, email: raw?.contact_email || raw?.email || "" } : null;
    ship = normalizeAddress(billingRest);
  }
  // GraphQL fallback
  if (!ship && orderGid) {
    const q = `query($id:ID!){
      order(id:$id){
        email
        shippingAddress{ name address1 address2 city province provinceCode zip countryCodeV2 phone }
        billingAddress{ name address1 address2 city province provinceCode zip countryCodeV2 phone }
      }
    }`;
    const r = await gql(q, { id: orderGid });
    if (r.ok) {
      const email = jget(r.json,["data","order","email"]) || "";
      const shipG = jget(r.json,["data","order","shippingAddress"]) || null;
      if (shipG) shipG.email = email;
      ship = normalizeAddress(shipG);
      if (!ship) {
        const billG = jget(r.json,["data","order","billingAddress"]) || null;
        if (billG) billG.email = email;
        ship = normalizeAddress(billG);
      }
    }
  }
  if (!ship) {
    console.warn("no-address-after-fallbacks", { order: orderName });
    return new Response(JSON.stringify({ ok:true, skipped:"no-address-after-fallbacks", order: orderName }), { status:200 });
  }

  // Payload completo per SpedirePro: include "from" e "to"
  const payload = {
    merchant_reference: orderName || "UNKNOWN",
    from: {
      name: FROM_NAME, address1: FROM_ADDR1, address2: FROM_ADDR2,
      city: FROM_CITY, province: FROM_PROV, zip: FROM_ZIP,
      country: FROM_COUNTRY, phone: FROM_PHONE, email: FROM_EMAIL
    },
    to: {
      name: ship.name, address1: ship.address1, address2: ship.address2,
      city: ship.city, province: ship.province || "", zip: ship.zip,
      country: ship.country, phone: ship.phone, email: ship.email
    },
    parcel: {
      length_cm: Number.isFinite(DEF_L) ? DEF_L : 20,
      width_cm:  Number.isFinite(DEF_WD) ? DEF_WD : 12,
      height_cm: Number.isFinite(DEF_H) ? DEF_H : 5,
      weight_kg: Number.isFinite(DEF_WEIGHT) ? DEF_WEIGHT : 0.5,
    },
    // se SpedirePro richiede un servizio predefinito, abilita:
    // service_code: process.env.SPRO_SERVICE_CODE || undefined
  };

  const sp = await sproCreateLabel(payload);

  // salva eventuale reference e swap tag comunque, per evitare loop
  if (orderGid) {
    const ref =
      jget(sp.json,["reference"]) || jget(sp.json,["data","reference"]) || null;
    if (ref) {
      const m = `mutation($metafields:[MetafieldsSetInput!]!){
        metafieldsSet(metafields:$metafields){ userErrors{ message } }
      }`;
      const metafields = [{ ownerId: orderGid, namespace:"spro", key:"reference", type:"single_line_text_field", value:String(ref) }];
      await gql(m, { metafields });
    }
    const m2 = `mutation($id:ID!){
      add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
      rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
    }`;
    await gql(m2, { id: orderGid });
  }

  return new Response(JSON.stringify({
    ok:true,
    note: sp.ok ? "label-requested" : "label-request-failed",
    spro_status: sp.status,
    spro_body: sp.text?.slice(0,500) || null,
    order: orderName
  }), { status:200 });
}
