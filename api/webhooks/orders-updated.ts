// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

// === ENV obbligatorie ===
const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE  = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1"; // come docs
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || ""; // solo token (nessun "Bearer")

// === Default pacco ===
const [DEF_L, DEF_W, DEF_D] = (process.env.DEFAULT_DIM_CM || "20x12x5").split("x").map(Number);
const DEF_WEIGHT = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

// === Opzionali ===
const SPRO_COURIER = process.env.SPRO_COURIER || ""; // es. "SDA" o vuoto
const INCLUDE_RETURN = (process.env.SPRO_INCLUDE_RETURN || "false") === "true";
const COURIER_FALLBACK = (process.env.SPRO_COURIER_FALLBACK || "true") === "true";
const BOOK_PICKUP = (process.env.SPRO_BOOK_PICKUP || "false") === "true";

// ==== Utils ====
const pick = (o:any,p:(string|number)[])=>p.reduce((a,k)=>a&&typeof a==="object"?a[k]:undefined,o);
const hasTag = (t:any,tag:string)=> Array.isArray(t)?t.includes(tag): typeof t==="string"? t.split(",").map(s=>s.trim()).includes(tag): false;

function normalizeAddress(a:any){
  if (!a) return null;
  const country = a.countryCodeV2 || a.country_code || (typeof a.country==="string"&&a.country.length===2?a.country:null);
  const out = {
    name: a.name || [a.first_name,a.last_name].filter(Boolean).join(" ") || "Customer",
    street: a.address1,
    address2: a.address2 || "",
    city: a.city,
    province: a.province || a.province_code || a.provinceCode || "",
    postcode: a.zip || a.postal_code || a.postcode || "",
    country,
    phone: a.phone || "",
    email: a.email || "",
  };
  if (!out.street || !out.city || !out.postcode || !out.country) return null;
  return out;
}

async function readJson(req: NextRequest){
  try { return await req.json(); } catch { return null; }
}

async function shopifyGQL(query:string, variables?:Record<string,any>){
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type":"application/json" },
    body: JSON.stringify({ query, variables: variables||{} }),
  });
  const text = await res.text(); let json:any; try{ json=JSON.parse(text);}catch{}
  if (!res.ok || json?.errors) return { ok:false, status:res.status, json, text };
  return { ok:true, json };
}

// === SpedirePro /create-label ===
async function sproCreateLabel(payload:any){
  if (!SPRO_TOKEN) return { ok:false, status:0, reason:"missing-token", text:null };
  const res = await fetch(`${SPRO_BASE}/create-label`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "X-Api-Key": SPRO_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload),
  });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  console.log("SpedirePro /create-label ->", res.status, ct.slice(0,60), text.slice(0,200));
  if (!ct.includes("application/json")) return { ok:false, status:res.status, reason:"non-json-response", text };
  let json:any; try{ json=JSON.parse(text);}catch{ return { ok:false, status:res.status, reason:"bad-json", text }; }
  if (!res.ok) return { ok:false, status:res.status, reason:"api-error", text, json };
  return { ok:true, status:res.status, reason:"ok", text, json };
}

export default async function handler(req: NextRequest){
  if (req.method!=="POST") return new Response(JSON.stringify({ ok:false, error:"method-not-allowed"}), { status:405 });

  const raw:any = await readJson(req);
  if (!raw) return new Response(JSON.stringify({ ok:true, skipped:"invalid-json"}), { status:200 });

  const orderName = raw?.name || (raw?.order_number?`#${raw.order_number}`:null);
  const orderGid  = raw?.admin_graphql_api_id || null;
  const tags      = raw?.tags ?? raw?.tag_string;

  if (!hasTag(tags,"SPRO-CREATE")) return new Response(JSON.stringify({ ok:true, skipped:"no-SPRO-CREATE"}), { status:200 });

  // indirizzo: usa shipping; fallback billing
  let ship = normalizeAddress(raw?.shipping_address);
  if (!ship) {
    const bill = raw?.billing_address ? { ...raw.billing_address, email: raw?.contact_email || raw?.email || "" } : null;
    ship = normalizeAddress(bill);
  }
  if (!ship) return new Response(JSON.stringify({ ok:true, skipped:"no-address", order:orderName }), { status:200 });

  // Mappa ai campi richiesti dalla doc: sender, receiver, packages
  const payload:any = {
    merchant_reference: orderName || "UNKNOWN",
    include_return_label: INCLUDE_RETURN,
    courier_fallback: COURIER_FALLBACK,
    book_pickup: BOOK_PICKUP,
    sender: {
      name: "Catholically",
      attention_name: "",
      city: "Roma",
      postcode: "00100",
      province: "RM",
      country: "IT",
      street: "Via Roma 1",
      email: "support@catholically.com",
      phone: "+39000000000"
    },
    receiver: {
      name: ship.name,
      attention_name: "",
      city: ship.city,
      postcode: ship.postcode,
      province: ship.province || "",
      country: ship.country,
      street: `${ship.street}${ship.address2 ? ", "+ship.address2 : ""}`,
      email: ship.email,
      phone: ship.phone
    },
    packages: [
      { width: DEF_W, height: DEF_D, depth: DEF_L, weight: DEF_WEIGHT }
    ]
  };
  if (SPRO_COURIER) payload.courier = SPRO_COURIER;

  const sp = await sproCreateLabel(payload);

  // salva reference (se presente) + swap tag
  if (orderGid){
    const ref = pick(sp as any, ["json","reference"]) || pick(sp as any, ["json","data","reference"]) || null;
    if (ref){
      const m = `mutation($metafields:[MetafieldsSetInput!]!){
        metafieldsSet(metafields:$metafields){ userErrors{ message } }
      }`;
      await shopifyGQL(m, { metafields:[{ ownerId: orderGid, namespace:"spro", key:"reference", type:"single_line_text_field", value:String(ref)}] });
    }
    const m2 = `mutation($id:ID!){
      add: tagsAdd(id:$id, tags:["SPRO-SENT"]){ userErrors{ message } }
      rem: tagsRemove(id:$id, tags:["SPRO-CREATE"]){ userErrors{ message } }
    }`;
    await shopifyGQL(m2, { id: orderGid });
  }

  return new Response(JSON.stringify({
    ok: sp.ok,
    note: sp.ok ? "label-requested" : "label-request-failed",
    reason: (sp as any).reason || null,
    spro_status: sp.status || 0,
    spro_body_snippet: (sp as any).text ? (sp as any).text.slice(0,200) : null,
    order: orderName
  }), { status:200 });
}
