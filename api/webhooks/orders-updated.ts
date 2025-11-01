// api/webhooks/orders-updated.ts
// Runtime Edge
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

// ENV richieste
const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || ""; // "Bearer xxx"
const [DEF_L, DEF_WD, DEF_H] = (process.env.DEFAULT_DIM_CM || "20x12x5").split("x").map(Number);
const DEF_WEIGHT = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

const jget = (o:any,p:(string|number)[])=>p.reduce((a,k)=>a&&typeof a==="object"?a[k]:undefined,o);

async function readBody(req: NextRequest){
  // Shopify può inviare gzip
  const enc = req.headers.get("content-encoding");
  try {
    if (enc === "gzip") {
      const ab = await req.arrayBuffer();
      // DecompressionStream è disponibile su Edge
      const ds = new DecompressionStream("gzip");
      const decompressed = new Response(
        new Blob([ab]).stream().pipeThrough(ds)
      );
      const txt = await decompressed.text();
      return JSON.parse(txt);
    }
    // default JSON
    return await req.json();
  } catch (e:any) {
    console.error("orders-updated: invalid-json", { enc, err: String(e?.message||e) });
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
  if (!res.ok || json?.errors) {
    console.error("orders-updated: gql-error", { status: res.status, text: text.slice(0,500) });
    return { ok:false, status:res.status, json, text };
  }
  return { ok:true, json };
}

function hasTag(input:any, tag:string){
  if (!input) return false;
  if (Array.isArray(input)) return input.includes(tag);
  if (typeof input === "string") return input.split(",").map((s)=>s.trim()).includes(tag);
  return false;
}

async function sproCreateLabel(payload:any){
  if (!SPRO_TOKEN) {
    console.warn("orders-updated: SPRO_API_TOKEN missing, skip create-label");
    return { ok:false, status:0, json:null, text:"missing SPRO_API_TOKEN" };
  }
  const url = `${SPRO_BASE}/create-label`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: SPRO_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json:any; try{ json = JSON.parse(text); } catch {}
  if (!res.ok) {
    console.error("orders-updated: spro-create-label-failed", { status: res.status, text: text.slice(0,500) });
    return { ok:false, status: res.status, json, text };
  }
  return { ok:true, status: res.status, json, text };
}

export default async function handler(req: NextRequest){
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok:false, error:"method-not-allowed" }), { status:405 });
  }

  // 1) Body
  const body:any = await readBody(req);
  if (!body) {
    // Non inviare 400 a Shopify per non generare retry a cascata. Torna 200 con skip.
    return new Response(JSON.stringify({ ok:true, skipped:"invalid-json" }), { status:200 });
  }

  // 2) Info ordine dal payload REST di Shopify
  const orderName = body?.name || (body?.order_number ? `#${body.order_number}` : null);
  const orderGid  = body?.admin_graphql_api_id || null;
  const tags      = body?.tags ?? body?.tag_string;

  console.log("orders-updated: incoming", {
    name: orderName, hasCreate: hasTag(tags,"SPRO-CREATE"),
  });

  // 3) Trigger tag
  if (!hasTag(tags, "SPRO-CREATE")) {
    return new Response(JSON.stringify({ ok:true, skipped:"no-SPRO-CREATE" }), { status:200 });
  }

  // 4) Shipping address
  let ship = body?.shipping_address;
  if (!ship && orderGid) {
    const q = `query($id:ID!){ order(id:$id){ shippingAddress{
      name address1 address2 city province zip countryCodeV2 phone
    } } }`;
    const r = await gql(q, { id: orderGid });
    if (!r.ok) {
      return new Response(JSON.stringify({ ok:true, skipped:"addr-lookup-failed"}), { status:200 });
    }
    ship = jget(r.json, ["data","order","shippingAddress"]);
  }

  if (!ship?.address1 || !ship?.city || !ship?.zip || !ship?.countryCodeV2) {
    console.warn("orders-updated: missing-shipping-address", { order: orderName });
    return new Response(JSON.stringify({ ok:true, skipped:"no-shipping-address" }), { status:200 });
  }

  // 5) Prepara payload SpedirePro
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
    parcel: {
      length_cm: Number.isFinite(DEF_L) ? DEF_L : 20,
      width_cm:  Number.isFinite(DEF_WD) ? DEF_WD : 12,
      height_cm: Number.isFinite(DEF_H) ? DEF_H : 5,
      weight_kg: Number.isFinite(DEF_WEIGHT) ? DEF_WEIGHT : 0.5,
    },
  };

  // 6) Chiamata SpedirePro
  const sp = await sproCreateLabel(payload);
  if (!sp.ok) {
    // Non bloccare il flusso: ritorna 200 e spiega nei log il motivo.
    return new Response(JSON.stringify({ ok:true, note:"label-request-failed", reason: sp.status || "missing-token" }), { status:200 });
  }

  // 7) Salva reference su metafield (facoltativo)
  if (orderGid) {
    const ref = jget(sp.json, ["reference"]) || jget(sp.json, ["data","reference"]) || null;
    if (ref) {
      const m = `mutation($metafields:[MetafieldsSetInput!]!){
        metafieldsSet(metafields:$metafields){ userErrors{ message } }
      }`;
      const metafields = [{ ownerId: orderGid, namespace: "spro", key: "reference", type: "single_line_text_field", value: String(ref) }];
      await gql(m, { metafields });
    }
    // tag swap
    const m2 = `mutation($id:ID!){
      add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
      rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
    }`;
    await gql(m2, { id: orderGid });
  }

  return new Response(JSON.stringify({ ok:true, note:"label-requested", order: orderName }), { status:200 });
}
