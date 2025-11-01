// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

/*
 ENV richieste (Vercel):
 - SHOPIFY_SHOP                es. holy-trove.myshopify.com
 - SHOPIFY_ADMIN_TOKEN         Admin API token
 - SPRO_API_BASE               es. https://www.spedirepro.com/public-api/v1
 - SPRO_API_TOKEN              API key SPRO (può essere SOLO token: il codice aggiunge "Bearer " se manca)
 - DEFAULT_PARCEL_CM           es. "20x12x5"
 - DEFAULT_WEIGHT_KG           es. "0.5"
 - SPRO_SERVICE                opzionale, es. "UPS 5-day" o lasciare vuoto
*/

const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN_RAW = process.env.SPRO_API_TOKEN || "";
const DEFAULT_PARCEL = (process.env.DEFAULT_PARCEL_CM || "20x12x5").split("x").map(n=>Number(n.trim())) as [number,number,number];
const DEFAULT_WEIGHT = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");
const SPRO_SERVICE   = process.env.SPRO_SERVICE || ""; // opzionale

function sproAuthHeaders(){
  const hasBearer = /^bearer\s+/i.test(SPRO_TOKEN_RAW);
  const value = hasBearer ? SPRO_TOKEN_RAW : `Bearer ${SPRO_TOKEN_RAW}`;
  return {
    "X-Api-Key": value,
    "Authorization": value,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

async function readJson(req: NextRequest){ try { return await req.json(); } catch { return null; } }
function ok(data:any){ return new Response(JSON.stringify({ ok:true, ...data }), { status:200 }); }
function bad(code:number,msg:string,data?:any){ return new Response(JSON.stringify({ ok:false, error:msg, ...(data?{detail:data}:{}) }), { status:code }); }

async function shopifyREST(path:string, init?:RequestInit){
  const res = await fetch(`https://${SHOP}/admin/api/2025-10${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init?.headers||{})
    }
  });
  const text = await res.text();
  let json:any; try{ json=JSON.parse(text);}catch{}
  return { ok: res.ok, status: res.status, json, text };
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

// -- Helpers indirizzo --
function toStateCode(countryCode?:string, provinceCode?:string, province?:string){
  if (countryCode === "US"){
    if (provinceCode && provinceCode.length === 2) return provinceCode;
    // fallback: mappa alcuni stati comuni
    const map:Record<string,string> = {
      "Texas":"TX","California":"CA","New York":"NY","Florida":"FL","Illinois":"IL","Pennsylvania":"PA",
      "Ohio":"OH","Georgia":"GA","North Carolina":"NC","Michigan":"MI","Washington":"WA","Arizona":"AZ",
      "Massachusetts":"MA","Tennessee":"TN","Indiana":"IN","Missouri":"MO","Maryland":"MD","Wisconsin":"WI",
      "Colorado":"CO","Minnesota":"MN","South Carolina":"SC","Alabama":"AL","Louisiana":"LA","Kentucky":"KY",
      "Oregon":"OR","Oklahoma":"OK","Connecticut":"CT","Utah":"UT","Iowa":"IA","Nevada":"NV","Arkansas":"AR",
      "Mississippi":"MS","Kansas":"KS","New Mexico":"NM","Nebraska":"NE","Idaho":"ID","West Virginia":"WV",
      "Hawaii":"HI","New Jersey":"NJ","Virginia":"VA","Washington DC":"DC","District of Columbia":"DC",
      "Montana":"MT","Maine":"ME","New Hampshire":"NH","Vermont":"VT","Rhode Island":"RI","Delaware":"DE",
      "Alaska":"AK","North Dakota":"ND","South Dakota":"SD","Wyoming":"WY"
    };
    if (province && map[province]) return map[province];
  }
  // altrimenti restituisci il provinceCode così com’è se disponibile
  return provinceCode || province || "";
}

function parseDims(dm:[number,number,number]){
  const [l,w,h] = dm;
  return {
    length_cm: Math.max(1, Math.round(l)),
    width_cm:  Math.max(1, Math.round(w)),
    height_cm: Math.max(1, Math.round(h)),
  };
}

// -- SPRO get-label (subito dopo create), così popoliamo label_url anche se SPRO non ce la manda via webhook --
function extractLabelUrlFromText(text:string){
  const m1 = text.match(/https?:\/\/(?:www\.)?spedirepro\.com\/bridge\/label\/[A-Za-z0-9_-]+(?:\?[^"'\s<>\)]*)?/i);
  if (m1) return m1[0];
  const m2 = text.match(/https?:\/\/files\.spedirepro\.com\/labels\/[A-Za-z0-9/_-]+\.pdf/i);
  if (m2) return m2[0];
  return null;
}
async function sproGetLabel(reference: string){
  const tries = [
    { order: reference },
    { reference },
    { shipment: reference },
    { shipment_number: reference }
  ];
  for (const body of tries){
    const res = await fetch(`${SPRO_BASE}/get-label`, {
      method: "POST",
      headers: sproAuthHeaders(),
      body: JSON.stringify(body)
    });
    const ct = (res.headers.get("content-type")||"").toLowerCase();
    const text = await res.text();
    if (ct.includes("application/json")){
      let js:any; try{ js=JSON.parse(text);}catch{ js=null; }
      const link = js?.label?.link || js?.link || js?.url || js?.data?.label || js?.data?.link || js?.data?.url;
      if (res.ok && link) return String(link);
    }
    const fromText = extractLabelUrlFromText(text);
    if (fromText) return fromText;
  }
  return null;
}

// -- Metafields --
async function setOrderMetafields(orderGid:string, fields: Record<string,string>){
  const metas = Object.entries(fields)
    .filter(([,v]) => !!v)
    .map(([k,v]) => ({
      ownerId: orderGid, namespace:"spro", key:k,
      type: k==="label_url" ? "url" : "single_line_text_field",
      value: String(v)
    }));
  if (!metas.length) return { ok:true };
  const m = `mutation($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){ userErrors{ message } }
  }`;
  return await shopifyGQL(m, { metafields: metas });
}

// -- Tag helpers --
async function replaceTag(orderId:number, removeTag:string, addTag:string){
  const gres = await shopifyREST(`/orders/${orderId}.json`, { method:"GET" });
  if (!gres.ok) return gres;
  const tagsStr:string = gres.json?.order?.tags || "";
  const tags = tagsStr.split(",").map((t:string)=>t.trim()).filter(Boolean);
  const filtered = tags.filter((t:string)=> t.toLowerCase() !== removeTag.toLowerCase());
  if (!filtered.includes(addTag)) filtered.push(addTag);
  return await shopifyREST(`/orders/${orderId}.json`, {
    method:"PUT",
    body: JSON.stringify({ order: { id: orderId, tags: filtered.join(", ") } })
  });
}

export default async function handler(req: NextRequest){
  if (req.method !== "POST") return bad(405,"method-not-allowed");

  // Shopify invia application/json con il body dell'evento
  const body = await readJson(req);
  if (!body) return bad(400,"invalid-json");

  // Shopify Orders updated payload (REST-like)
  const order = body?.order || body;
  const orderId: number = order?.id;
  const orderGid: string = order?.admin_graphql_api_id;
  const name: string = order?.name; // es. "#3557xxxxxxx"
  const tagsStr: string = order?.tags || "";
  const hasTrigger = tagsStr.split(",").map((t:string)=>t.trim()).includes("SPRO-CREATE");

  if (!orderId || !orderGid || !name) return bad(400,"missing-order-fields");

  if (!hasTrigger){
    // Non fare nulla se non c'è il tag SPRO-CREATE
    return ok({ skipped:true, reason:"missing-SPRO-CREATE" });
  }

  // Ricarica l'ordine completo via REST per avere indirizzi/contatti aggiornati
  const r = await shopifyREST(`/orders/${orderId}.json`, { method:"GET" });
  if (!r.ok) return bad(502, "shopify-order-fetch-failed", r);

  const full = r.json?.order;
  const ship = full?.shipping_address || {};
  const bill = full?.billing_address || {};
  const email = full?.email || full?.contact_email || "";
  const phone = ship?.phone || bill?.phone || "";

  // Validazioni minime richieste da SPRO
  if (!email)  return bad(400, "missing-receiver-email");
  if (!ship?.address1 || !ship?.city || !ship?.zip || !ship?.country_code) return bad(400, "missing-shipping-address");

  const stateCode = toStateCode(ship?.country_code, ship?.province_code, ship?.province);
  const { length_cm, width_cm, height_cm } = parseDims(DEFAULT_PARCEL);

  // Costruzione payload SPRO
  const payload:any = {
    // Identificativo nostro per ritrovarlo dopo nel webhook: sempre il name "#NNN"
    merchant_reference: name,

    // Dati destinatario
    receiver: {
      first_name: ship?.first_name || bill?.first_name || "",
      last_name:  ship?.last_name  || bill?.last_name  || "",
      email,
      phone: phone || "",
      address: {
        country: ship?.country_code,
        state: stateCode, // forziamo "TX" ecc.
        city: ship?.city,
        postcode: ship?.zip,
        address: ship?.address1 + (ship?.address2 ? ` ${ship.address2}` : "")
      }
    },

    // Pacco (default)
    parcel: {
      weight_kg: DEFAULT_WEIGHT,
      length_cm, width_cm, height_cm,
    },

    // Opzionale: servizio scelto (se vuoi valorizzare)
    ...(SPRO_SERVICE ? { service: SPRO_SERVICE } : {}),

    // mittente opzionale: se vuoi fissare Roma/Milano, aggiungi qui i tuoi dati
    // sender: { ... }
  };

  // Chiama SPRO /create-label
  const createRes = await fetch(`${SPRO_BASE}/create-label`, {
    method: "POST",
    headers: sproAuthHeaders(),
    body: JSON.stringify(payload)
  });

  const ct = (createRes.headers.get("content-type")||"").toLowerCase();
  const raw = await createRes.text();
  console.log("orders-updated: SpedirePro /create-label ->", createRes.status, ct, raw.slice(0,200));

  // /create-label a volte può rispondere HTML (login page) se token errato → controlliamo
  if (!ct.includes("application/json")){
    return bad(502, "spro-create-non-json", { status: createRes.status, snippet: raw.slice(0,400) });
  }

  let js:any; try{ js=JSON.parse(raw);}catch{ js=null; }
  if (!createRes.ok || !js){
    return bad(502, "spro-create-failed", { status: createRes.status, body: js || raw.slice(0,400) });
  }

  // La risposta spesso contiene "order" o "reference" (numero spedizione SPRO)
  const reference = js?.order || js?.reference || js?.shipment || js?.shipment_number || "";
  console.log("orders-updated: created shipment reference =", reference);

  // Subito dopo proviamo /get-label per riempire metafield label_url
  let labelUrl:string|null = null;
  if (reference){
    try{
      labelUrl = await sproGetLabel(reference);
      if (labelUrl) console.log("orders-updated: resolved labelUrl", labelUrl);
    }catch{}
  }

  // Salva subito i metafield su ordine: spro.reference (+ spro.label_url se trovata)
  const saveMeta = await setOrderMetafields(orderGid, {
    reference: reference || "",
    ...(labelUrl ? { label_url: labelUrl } : {})
  });
  if (!saveMeta.ok) {
    console.log("orders-updated: metafieldsSet errors", saveMeta);
  }

  // Rimpiazza il tag: SPRO-CREATE → SPRO-SENT
  const retag = await replaceTag(orderId, "SPRO-CREATE", "SPRO-SENT");
  if (!retag.ok) {
    console.log("orders-updated: replaceTag failed", retag);
  }

  return ok({
    status: "spro-label-created",
    order: name,
    reference: reference || null,
    label: labelUrl || null
  });
}
