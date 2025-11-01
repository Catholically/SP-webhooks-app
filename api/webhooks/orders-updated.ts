// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

/* ENV richieste
  SHOPIFY_SHOP                es. holy-trove.myshopify.com
  SHOPIFY_ADMIN_TOKEN         Admin API token
  SPRO_API_BASE               es. https://www.spedirepro.com/public-api/v1
  SPRO_API_TOKEN              API key SPRO (accetto sia “xxxxx” sia “Bearer xxxxx”)
  DEFAULT_PARCEL_CM           es. "20x12x5"  (LxWxH cm)
  DEFAULT_WEIGHT_KG           es. "0.5"
  SPRO_SERVICE                opzionale es. "UPS 5-day"
*/

const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SPRO_BASE  = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN = (() => {
  const raw = process.env.SPRO_API_TOKEN || "";
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
})();

const DEFAULT_PARCEL = (process.env.DEFAULT_PARCEL_CM || "20x12x5")
  .split("x").map(n => Number(n.trim())) as [number,number,number];
const DEFAULT_WEIGHT = Number(process.env.DEFAULT_WEIGHT_KG || "0.5");
const SPRO_SERVICE   = process.env.SPRO_SERVICE || "";

function sproHeaders() {
  return {
    "Authorization": SPRO_TOKEN,
    "X-Api-Key": SPRO_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

async function readJson(req: NextRequest) {
  try { return await req.json(); } catch { return null; }
}
function j200(obj: any) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}
function jErr(code: number, msg: string, extra?: any) {
  return new Response(JSON.stringify({ ok: false, error: msg, ...(extra?{detail:extra}:{}) }), {
    status: code, headers: { "Content-Type": "application/json" }
  });
}

async function shopifyREST(path: string, init?: RequestInit) {
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
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function shopifyGQL(query: string, variables?: Record<string,any>) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok || json?.errors) return { ok:false, status:res.status, json, text };
  return { ok:true, json };
}

function toStateCode(country?: string, provCode?: string, prov?: string) {
  if (country === "US") {
    if (provCode && provCode.length === 2) return provCode;
    const map: Record<string,string> = {
      "Texas":"TX","California":"CA","New York":"NY","Florida":"FL","Illinois":"IL","Pennsylvania":"PA",
      "Ohio":"OH","Georgia":"GA","North Carolina":"NC","Michigan":"MI","Washington":"WA","Arizona":"AZ",
      "Massachusetts":"MA","Tennessee":"TN","Indiana":"IN","Missouri":"MO","Maryland":"MD","Wisconsin":"WI",
      "Colorado":"CO","Minnesota":"MN","South Carolina":"SC","Alabama":"AL","Louisiana":"LA","Kentucky":"KY",
      "Oregon":"OR","Oklahoma":"OK","Connecticut":"CT","Utah":"UT","Iowa":"IA","Nevada":"NV","Arkansas":"AR",
      "Mississippi":"MS","Kansas":"KS","New Mexico":"NM","Nebraska":"NE","Idaho":"ID","West Virginia":"WV",
      "Hawaii":"HI","New Jersey":"NJ","Virginia":"VA","District of Columbia":"DC","Montana":"MT","Maine":"ME",
      "New Hampshire":"NH","Vermont":"VT","Rhode Island":"RI","Delaware":"DE","Alaska":"AK","North Dakota":"ND",
      "South Dakota":"SD","Wyoming":"WY"
    };
    if (prov && map[prov]) return map[prov];
  }
  return provCode || prov || "";
}

function parseDims(dm:[number,number,number]) {
  const [l,w,h] = dm;
  return { length_cm: Math.max(1, Math.round(l)), width_cm: Math.max(1, Math.round(w)), height_cm: Math.max(1, Math.round(h)) };
}

function extractLabelUrlFromText(text: string) {
  const m1 = text.match(/https?:\/\/(?:www\.)?spedirepro\.com\/(?:bridge\/)?label\/[A-Za-z0-9_-]+(?:\?[^"'<>\s]*)?/i);
  if (m1) return m1[0];
  const m2 = text.match(/https?:\/\/files\.spedirepro\.com\/labels\/[A-Za-z0-9/_-]+\.pdf/i);
  if (m2) return m2[0];
  return null;
}

async function sproGetLabel(reference: string) {
  const tries = [
    { order: reference },
    { reference },
    { shipment: reference },
    { shipment_number: reference },
  ];
  for (const body of tries) {
    const r = await fetch(`${SPRO_BASE}/get-label`, { method: "POST", headers: sproHeaders(), body: JSON.stringify(body) });
    const ct = (r.headers.get("content-type")||"").toLowerCase();
    const text = await r.text();
    if (ct.includes("application/json")) {
      let js: any = null; try { js = JSON.parse(text); } catch {}
      const link = js?.label?.link || js?.link || js?.url || js?.data?.label || js?.data?.link || js?.data?.url;
      if (r.ok && link) return String(link);
    }
    const fromText = extractLabelUrlFromText(text);
    if (fromText) return fromText;
  }
  return null;
}

async function setOrderMetafields(orderGid: string, fields: Record<string,string>) {
  const metas = Object.entries(fields)
    .filter(([,v]) => !!v)
    .map(([k,v]) => ({
      ownerId: orderGid,
      namespace: "spedirepro",
      key: k,                              // "reference" | "ldv_url"
      type: k === "ldv_url" ? "url" : "single_line_text_field",
      value: String(v),
    }));
  if (!metas.length) return { ok:true };
  const m = `mutation($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){ userErrors{ message field } }
  }`;
  return await shopifyGQL(m, { metafields: metas });
}

async function replaceTag(orderId: number, removeTag: string, addTag: string) {
  const g = await shopifyREST(`/orders/${orderId}.json`, { method:"GET" });
  if (!g.ok) return g;
  const tagsStr: string = g.json?.order?.tags || "";
  const tags = tagsStr.split(",").map((t:string)=>t.trim()).filter(Boolean);
  const filtered = tags.filter((t:string)=> t.toLowerCase() !== removeTag.toLowerCase());
  if (!filtered.includes(addTag)) filtered.push(addTag);
  return await shopifyREST(`/orders/${orderId}.json`, {
    method: "PUT",
    body: JSON.stringify({ order: { id: orderId, tags: filtered.join(", ") } })
  });
}

export default async function handler(req: NextRequest) {
  try {
    if (req.method !== "POST") return jErr(405, "method-not-allowed");

    const payload = await readJson(req);
    if (!payload) return jErr(400, "invalid-json");

    const order = payload?.order || payload;
    const orderId: number   = order?.id;
    const orderGid: string  = order?.admin_graphql_api_id;
    const name: string      = order?.name;    // "#NNNN"
    const tagsStr: string   = order?.tags || "";

    if (!orderId || !orderGid || !name) return jErr(400, "missing-order-fields");

    const hasTrigger = tagsStr.split(",").map((t:string)=>t.trim()).includes("SPRO-CREATE");
    if (!hasTrigger) return j200({ ok:true, skipped:true, reason:"missing-SPRO-CREATE" });

    // Carico l’ordine completo
    const r = await shopifyREST(`/orders/${orderId}.json`, { method:"GET" });
    if (!r.ok) return jErr(502, "shopify-order-fetch-failed", { status: r.status });

    const full = r.json?.order || {};
    const ship = full?.shipping_address || {};
    const bill = full?.billing_address || {};
    const email = full?.email || full?.contact_email || "";
    const phone = ship?.phone || bill?.phone || "";

    if (!email) return jErr(400, "missing-receiver-email");
    if (!ship?.address1 || !ship?.city || !ship?.zip || !ship?.country_code) return jErr(400, "missing-shipping-address");

    const stateCode = toStateCode(ship?.country_code, ship?.province_code, ship?.province);
    const { length_cm, width_cm, height_cm } = parseDims(DEFAULT_PARCEL);

    const sproPayload: any = {
      merchant_reference: name,
      receiver: {
        first_name: ship?.first_name || bill?.first_name || "",
        last_name:  ship?.last_name  || bill?.last_name  || "",
        email,
        phone: phone || "",
        address: {
          country: ship?.country_code,
          state: stateCode,
          city: ship?.city,
          postcode: ship?.zip,
          address: ship?.address1 + (ship?.address2 ? ` ${ship.address2}` : "")
        }
      },
      parcel: { weight_kg: DEFAULT_WEIGHT, length_cm, width_cm, height_cm },
      ...(SPRO_SERVICE ? { service: SPRO_SERVICE } : {}),
    };

    // Crea spedizione
    const cRes = await fetch(`${SPRO_BASE}/create-label`, {
      method: "POST", headers: sproHeaders(), body: JSON.stringify(sproPayload)
    });
    const cText = await cRes.text();
    const cCT = (cRes.headers.get("content-type")||"").toLowerCase();
    let cJson: any = null; try { if (cCT.includes("json")) cJson = JSON.parse(cText); } catch {}

    if (!cRes.ok || !cJson) return jErr(502, "spro-create-failed", { status: cRes.status });

    const reference = cJson?.order || cJson?.reference || cJson?.shipment || cJson?.shipment_number || "";
    let labelUrl: string | null = null;

    if (reference) {
      try { labelUrl = await sproGetLabel(reference); } catch {}
    }

    // Scrivo i metafield nello spazio “spedirepro”
    const metaSave = await setOrderMetafields(orderGid, {
      reference: reference || "",
      ...(labelUrl ? { ldv_url: labelUrl } : {})
    });
    if (!metaSave.ok) {
      // non blocco il flusso
    }

    // Tag: SPRO-CREATE -> SPRO-SENT
    await replaceTag(orderId, "SPRO-CREATE", "SPRO-SENT");

    return j200({
      ok: true,
      status: "spro-label-created",
      order: name,
      reference: reference || null,
      label_url: labelUrl || null
    });

  } catch (e: any) {
    // Evito 502: rispondo sempre 200 con errore serializzato
    return j200({ ok:false, error:"unhandled-exception", message: String(e?.message || e) });
  }
}
