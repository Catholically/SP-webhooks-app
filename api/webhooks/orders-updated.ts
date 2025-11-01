// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

// ==== ENV ====
const SHOP = process.env.SHOPIFY_SHOP!;                    // es: holy-trove.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;            // Admin API access token (private app)
const SPRO_BASE = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || "";       // SOLO token, senza "Bearer "
const [DEF_L, DEF_WD, DEF_H] = (process.env.DEFAULT_DIM_CM || "20x12x5").split("x").map(Number);
const DEF_WEIGHT = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

// ==== UTILS ====
const pick = (o: any, path: (string|number)[]) =>
  path.reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), o);

function hasTag(input: any, tag: string) {
  if (!input) return false;
  if (Array.isArray(input)) return input.includes(tag);
  if (typeof input === "string") return input.split(",").map(s => s.trim()).includes(tag);
  return false;
}

function normalizeAddress(a: any) {
  if (!a) return null;
  const country =
    a.countryCodeV2 ||
    a.country_code ||
    (typeof a.country === "string" && a.country.length === 2 ? a.country : null);

  const out = {
    name: a.name || [a.first_name, a.last_name].filter(Boolean).join(" ") || "Customer",
    address1: a.address1,
    address2: a.address2 || "",
    city: a.city,
    province: a.province || a.province_code || a.provinceCode || "",
    zip: a.zip || a.postal_code || a.postcode || "",
    country,
    phone: a.phone || "",
    email: a.email || "",
  };
  if (!out.address1 || !out.city || !out.zip || !out.country) return null;
  return out;
}

async function readJson(req: NextRequest) {
  const enc = req.headers.get("content-encoding");
  try {
    if (enc === "gzip") {
      const ab = await req.arrayBuffer();
      const ds = new DecompressionStream("gzip");
      const decompressed = new Response(new Blob([ab]).stream().pipeThrough(ds));
      return JSON.parse(await decompressed.text());
    }
    return await req.json();
  } catch {
    return null;
  }
}

async function shopifyGQL(query: string, variables?: Record<string, any>) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch {}
  if (!res.ok || json?.errors) return { ok: false, status: res.status, json, text };
  return { ok: true, json };
}

async function sproCreateLabel(payload: any) {
  if (!SPRO_TOKEN) {
    console.error("SPRO_API_TOKEN mancante in ENV (senza 'Bearer').");
    return { ok: false, status: 0, text: "missing-token" };
  }
  const res = await fetch(`${SPRO_BASE}/create-label`, {
    method: "POST",
    headers: {
      "X-Api-Key": SPRO_TOKEN,               // <- conforme a documentazione SpedirePro
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log("SpedirePro /create-label →", res.status, text.slice(0, 300));
  if (!res.ok) return { ok: false, status: res.status, text };
  let json: any; try { json = JSON.parse(text); } catch {}
  return { ok: true, status: res.status, json, text };
}

// ==== HANDLER ====
export default async function handler(req: NextRequest) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method-not-allowed" }), { status: 405 });
  }

  const raw: any = await readJson(req);
  if (!raw) return new Response(JSON.stringify({ ok: true, skipped: "invalid-json" }), { status: 200 });

  const orderName = raw?.name || (raw?.order_number ? `#${raw.order_number}` : null);
  const orderGid  = raw?.admin_graphql_api_id || null;
  const tags      = raw?.tags ?? raw?.tag_string;

  // Trigger
  if (!hasTag(tags, "SPRO-CREATE")) {
    return new Response(JSON.stringify({ ok: true, skipped: "no-SPRO-CREATE" }), { status: 200 });
  }

  // Address REST: shipping → billing
  let ship = normalizeAddress(raw?.shipping_address);
  if (!ship) {
    const billingRest = raw?.billing_address
      ? { ...raw.billing_address, email: raw?.contact_email || raw?.email || "" }
      : null;
    ship = normalizeAddress(billingRest);
  }

  // Address GraphQL fallback
  if (!ship && orderGid) {
    const q = `query($id:ID!){
      order(id:$id){
        email
        shippingAddress { name address1 address2 city province provinceCode zip countryCodeV2 phone }
        billingAddress  { name address1 address2 city province provinceCode zip countryCodeV2 phone }
      }
    }`;
    const r = await shopifyGQL(q, { id: orderGid });
    if (r.ok) {
      const email = pick(r.json, ["data","order","email"]) || "";
      const shipG = pick(r.json, ["data","order","shippingAddress"]) || null;
      if (shipG) shipG.email = email;
      ship = normalizeAddress(shipG);
      if (!ship) {
        const billG = pick(r.json, ["data","order","billingAddress"]) || null;
        if (billG) billG.email = email;
        ship = normalizeAddress(billG);
      }
    }
  }

  if (!ship) {
    return new Response(JSON.stringify({ ok: true, skipped: "no-address-after-fallbacks", order: orderName }), { status: 200 });
  }

  // Payload per SpedirePro
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

  // Call SpedirePro
  const sp = await sproCreateLabel(payload);

  // Salva reference e swappa tag
  if (orderGid) {
    const ref =
      pick(sp.json, ["reference"]) ||
      pick(sp.json, ["data","reference"]) || null;

    if (ref) {
      const m = `mutation($metafields:[MetafieldsSetInput!]!){
        metafieldsSet(metafields:$metafields){ userErrors{ message } }
      }`;
      const metafields = [{
        ownerId: orderGid,
        namespace: "spro",
        key: "reference",
        type: "single_line_text_field",
        value: String(ref),
      }];
      await shopifyGQL(m, { metafields });
    }

    const m2 = `mutation($id:ID!){
      add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
      rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
    }`;
    await shopifyGQL(m2, { id: orderGid });
  }

  return new Response(JSON.stringify({
    ok: true,
    note: sp.ok ? "label-requested" : "label-request-failed",
    spro_status: sp.status || 0,
    spro_body: sp.text?.slice(0,300) || null,
    order: orderName,
  }), { status: 200 });
}
