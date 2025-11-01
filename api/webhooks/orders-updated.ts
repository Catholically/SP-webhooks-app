// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

// === ENV base ===
const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE  = process.env.SPRO_API_BASE || "https://spedirepro.com/public-api/v1";
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || ""; // solo token, senza "Bearer"

// === Pacco default ===
const [DEF_L, DEF_W, DEF_D] = (process.env.DEFAULT_DIM_CM || "20x12x5").split("x").map(Number);
const DEF_WEIGHT = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");

// === Mittente da ENV ===
const SENDER = {
  name: process.env.SENDER_NAME || "",
  attention_name: process.env.SENDER_ATTENTION || "",
  city: process.env.SENDER_CITY || "",
  postcode: process.env.SENDER_ZIP || "",
  province: process.env.SENDER_PROV || "",
  country: process.env.SENDER_COUNTRY || "",
  street: [process.env.SENDER_ADDR1, process.env.SENDER_ADDR2].filter(Boolean).join(", "),
  email: process.env.SENDER_EMAIL || "",
  phone: process.env.SENDER_PHONE || "",
} as const;

const REQUIRED_SENDER_KEYS: Array<keyof typeof SENDER> =
  ["name","city","postcode","country","street","email","phone"];

function checkSenderEnv() {
  const miss = REQUIRED_SENDER_KEYS.filter(k => !String(SENDER[k]).trim());
  return miss;
}

// === Utils ===
const pick = (o:any,p:(string|number)[])=>p.reduce((a,k)=>a&&typeof a==="object"?a[k]:undefined,o);
const hasTag = (t:any,tag:string)=> Array.isArray(t)?t.includes(tag): typeof t==="string"? t.split(",").map(s=>s.trim()).includes(tag): false;

// Province: preferisci codice ISO2 (es. TX) rispetto al nome (Texas)
function normalizeAddress(a:any){
  if (!a) return null;
  const country =
    a.countryCodeV2 || a.country_code || (typeof a.country==="string" && a.country.length===2 ? a.country : null);
  const province =
    a.province_code || a.provinceCode || a.province || "";
  const out = {
    name: a.name || [a.first_name,a.last_name].filter(Boolean).join(" ") || "Customer",
    street: a.address1,
    address2: a.address2 || "",
    city: a.city,
    province,
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

// === SpedirePro ===
async function sproCreateLabel(payload:any){
  if (!SPRO_TOKEN) return { ok:false, status:0, reason:"missing-token", text:null };
  const res = await fetch(`${SPRO_BASE}/create-label`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "X-Api-Key": SPRO_TOKEN,
      "Content-Type":"application/json",
      "Accept":"application/json"
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

// === Handler ===
export default async function handler(req: NextRequest){
  if (req.method!=="POST") return new Response(JSON.stringify({ ok:false, error:"method-not-allowed"}), { status:405 });

  const senderMissing = checkSenderEnv();
  if (senderMissing.length){
    console.error("SENDER_* mancanti:", senderMissing.join(", "));
    return new Response(JSON.stringify({ ok:false, error:"sender-env-missing", missing: senderMissing }), { status:500 });
  }

  const raw:any = await readJson(req);
  if (!raw) return new Response(JSON.stringify({ ok:true, skipped:"invalid-json"}), { status:200 });

  const orderName = raw?.name || (raw?.order_number?`#${raw.order_number}`:null);
  const orderGid  = raw?.admin_graphql_api_id || null;
  const tags      = raw?.tags ?? raw?.tag_string;

  if (!hasTag(tags,"SPRO-CREATE")) return new Response(JSON.stringify({ ok:true, skipped:"no-SPRO-CREATE"}), { status:200 });

  const orderLevelEmail = (raw?.contact_email || raw?.email || "").trim();

  // Destinatario: shipping → billing
  let ship = normalizeAddress(raw?.shipping_address);
  if (!ship) {
    const bill = raw?.billing_address ? { ...raw.billing_address, email: orderLevelEmail } : null;
    ship = normalizeAddress(bill);
  }
  if (!ship) return new Response(JSON.stringify({ ok:true, skipped:"no-address", order:orderName }), { status:200 });

  // Fallback obbligatori per SpedirePro
  const receiverEmail = (ship.email || orderLevelEmail || process.env.RECEIVER_FALLBACK_EMAIL || SENDER.email).trim();
  const receiverPhone = (ship.phone || SENDER.phone).toString().trim();

  console.log("orders-updated: receiver.email =", receiverEmail, "receiver.phone =", receiverPhone);

  // Payload conforme a "Crea spedizione"
  const payload:any = {
    merchant_reference: orderName || "UNKNOWN",
    include_return_label: false,
    courier_fallback: true,
    book_pickup: false,
    sender: SENDER,
    receiver: {
      name: ship.name,
      attention_name: "",
      city: ship.city,
      postcode: ship.postcode,
      province: ship.province,     // ora usa ISO2 se disponibile
      country: ship.country,
      street: ship.address2 ? `${ship.street}, ${ship.address2}` : ship.street,
      email: receiverEmail,
      phone: receiverPhone,
    },
    packages: [
      { width: DEF_W, height: DEF_D, depth: DEF_L, weight: DEF_WEIGHT }
    ]
  };

  const sp = await sproCreateLabel(payload);

  // Salva reference e swap tag
  if (orderGid){
    const ref = pick(sp as any, ["json","reference"]) || pick(sp as any, ["json","data","reference"]) || pick(sp as any, ["json","order"]) || null;
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
