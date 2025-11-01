// api/webhooks/orders-updated.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

// ---------- ENV (catturati una volta per Edge) ----------
const ENV = {
  SHOP: process.env.SHOPIFY_SHOP!,
  TOKEN: process.env.SHOPIFY_ADMIN_TOKEN!,
  SPRO_BASE:
    process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1",
  SPRO_TOKEN_RAW: process.env.SPRO_API_TOKEN || "",
  DEFAULT_PARCEL_CM: process.env.DEFAULT_PARCEL_CM || "20x12x5",
  DEFAULT_WEIGHT_KG: Number(process.env.DEFAULT_WEIGHT_KG || "0.5"),
  SPRO_SERVICE: process.env.SPRO_SERVICE || "", // opzionale
};

// ---------- Utils ----------
const API_VER = "2025-10";

async function readJson(req: NextRequest) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
const ok = (data: any) =>
  new Response(JSON.stringify({ ok: true, ...data }), { status: 200 });
const bad = (status: number, error: string, detail?: any) =>
  new Response(JSON.stringify({ ok: false, error, ...(detail ? { detail } : {}) }), {
    status,
  });

function sproAuthHeaders() {
  const hasBearer = /^bearer\s+/i.test(ENV.SPRO_TOKEN_RAW);
  const value = hasBearer ? ENV.SPRO_TOKEN_RAW : `Bearer ${ENV.SPRO_TOKEN_RAW}`;
  return {
    "X-Api-Key": value,
    Authorization: value,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function shopifyREST(path: string, init?: RequestInit) {
  const res = await fetch(`https://${ENV.SHOP}/admin/api/${API_VER}${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": ENV.TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function shopifyGQL(query: string, variables?: Record<string, any>) {
  const res = await fetch(
    `https://${ENV.SHOP}/admin/api/${API_VER}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": ENV.TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    }
  );
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok || json?.errors)
    return { ok: false as const, status: res.status, json, text };
  return { ok: true as const, json };
}

// ---------- Address helpers ----------
function toStateCode(
  countryCode?: string,
  provinceCode?: string,
  province?: string
) {
  if (countryCode === "US") {
    if (provinceCode && provinceCode.length === 2) return provinceCode;
    const map: Record<string, string> = {
      Texas: "TX",
      California: "CA",
      "New York": "NY",
      Florida: "FL",
      Illinois: "IL",
      Pennsylvania: "PA",
      Ohio: "OH",
      Georgia: "GA",
      "North Carolina": "NC",
      Michigan: "MI",
      Washington: "WA",
      Arizona: "AZ",
      Massachusetts: "MA",
      Tennessee: "TN",
      Indiana: "IN",
      Missouri: "MO",
      Maryland: "MD",
      Wisconsin: "WI",
      Colorado: "CO",
      Minnesota: "MN",
      "South Carolina": "SC",
      Alabama: "AL",
      Louisiana: "LA",
      Kentucky: "KY",
      Oregon: "OR",
      Oklahoma: "OK",
      Connecticut: "CT",
      Utah: "UT",
      Iowa: "IA",
      Nevada: "NV",
      Arkansas: "AR",
      Mississippi: "MS",
      Kansas: "KS",
      "New Mexico": "NM",
      Nebraska: "NE",
      Idaho: "ID",
      "West Virginia": "WV",
      Hawaii: "HI",
      "New Jersey": "NJ",
      Virginia: "VA",
      "Washington DC": "DC",
      "District of Columbia": "DC",
      Montana: "MT",
      Maine: "ME",
      "New Hampshire": "NH",
      Vermont: "VT",
      "Rhode Island": "RI",
      Delaware: "DE",
      Alaska: "AK",
      "North Dakota": "ND",
      "South Dakota": "SD",
      Wyoming: "WY",
    };
    if (province && map[province]) return map[province];
  }
  return provinceCode || province || "";
}

function parseDims(cm: string) {
  const [l, w, h] = cm.split("x").map((n) => Number(n.trim()));
  return {
    length_cm: Math.max(1, Math.round(l || 1)),
    width_cm: Math.max(1, Math.round(w || 1)),
    height_cm: Math.max(1, Math.round(h || 1)),
  };
}

// ---------- SPRO label helpers ----------
function extractLabelUrlFromText(text: string) {
  const m1 = text.match(
    /https?:\/\/(?:www\.)?spedirepro\.com\/(?:bridge\/)?label\/[A-Za-z0-9_-]+(?:\?[^"'\s<>\)]*)?/i
  );
  if (m1) return m1[0];
  const m2 = text.match(
    /https?:\/\/files\.spedirepro\.com\/labels\/[A-Za-z0-9/_-]+\.pdf/i
  );
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
    const res = await fetch(`${ENV.SPRO_BASE}/get-label`, {
      method: "POST",
      headers: sproAuthHeaders(),
      body: JSON.stringify(body),
    });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();

    if (ct.includes("application/json")) {
      let js: any;
      try {
        js = JSON.parse(text);
      } catch {}
      const link =
        js?.label?.link ||
        js?.link ||
        js?.url ||
        js?.data?.label ||
        js?.data?.link ||
        js?.data?.url;
      if (res.ok && link) return String(link);
    }
    const fromText = extractLabelUrlFromText(text);
    if (fromText) return fromText;
  }
  return null;
}

// ---------- Metafields ----------
async function setOrderMetafields(
  orderGid: string,
  fields: Record<string, string>
) {
  const metas = Object.entries(fields)
    .filter(([, v]) => !!v)
    .map(([k, v]) => ({
      ownerId: orderGid,
      namespace: "spedirepro",
      key: k, // es. "reference" | "ldv_url"
      type: k === "ldv_url" ? "url" : "single_line_text_field",
      value: String(v),
    }));
  if (!metas.length) return { ok: true };

  const m = /* GraphQL */ `
    mutation($metafields:[MetafieldsSetInput!]!){
      metafieldsSet(metaFields:$metafields){ userErrors{ message } }
    }
  `.replace("metaFields", "metafields"); // per sicurezza

  return await shopifyGQL(m, { metafields: metas });
}

// ---------- Tags ----------
async function replaceTag(orderId: number, removeTag: string, addTag: string) {
  const gres = await shopifyREST(`/orders/${orderId}.json`, { method: "GET" });
  if (!gres.ok) return gres;

  const tagsStr: string = gres.json?.order?.tags || "";
  const tags = tagsStr
    .split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);
  const filtered = tags.filter(
    (t: string) => t.toLowerCase() !== removeTag.toLowerCase()
  );
  if (!filtered.includes(addTag)) filtered.push(addTag);

  return await shopifyREST(`/orders/${orderId}.json`, {
    method: "PUT",
    body: JSON.stringify({ order: { id: orderId, tags: filtered.join(", ") } }),
  });
}

// ---------- Handler ----------
export default async function handler(req: NextRequest) {
  try {
    if (req.method !== "POST") return bad(405, "method-not-allowed");

    const body = await readJson(req);
    if (!body) return bad(400, "invalid-json");

    // Shopify invia sia {order: {...}} sia direttamente l'oggetto
    const order = body?.order || body;
    const orderId: number = order?.id;
    const orderGid: string = order?.admin_graphql_api_id;
    const name: string = order?.name; // "#NNNN..."

    if (!orderId || !orderGid || !name)
      return bad(400, "missing-order-fields");

    const tagsStr: string = order?.tags || "";
    const hasTrigger = tagsStr
      .split(",")
      .map((t: string) => t.trim())
      .includes("SPRO-CREATE");
    if (!hasTrigger) return ok({ skipped: true, reason: "missing-SPRO-CREATE" });

    // Ricarica ordine completo per indirizzi e contatti
    const r = await shopifyREST(`/orders/${orderId}.json`, { method: "GET" });
    if (!r.ok) return bad(502, "shopify-order-fetch-failed", r);

    const full = r.json?.order;
    const ship = full?.shipping_address || {};
    const bill = full?.billing_address || {};
    const email = full?.email || full?.contact_email || "";
    const phone = ship?.phone || bill?.phone || "";

    if (!email) return bad(400, "missing-receiver-email");
    if (!ship?.address1 || !ship?.city || !ship?.zip || !ship?.country_code)
      return bad(400, "missing-shipping-address");

    const stateCode = toStateCode(
      ship?.country_code,
      ship?.province_code,
      ship?.province
    );
    const { length_cm, width_cm, height_cm } = parseDims(ENV.DEFAULT_PARCEL_CM);

    // Payload SPRO
    const payload: any = {
      merchant_reference: name,
      receiver: {
        first_name: ship?.first_name || bill?.first_name || "",
        last_name: ship?.last_name || bill?.last_name || "",
        email,
        phone: phone || "",
        address: {
          country: ship?.country_code,
          state: stateCode,
          city: ship?.city,
          postcode: ship?.zip,
          address:
            ship?.address1 + (ship?.address2 ? ` ${ship.address2}` : ""),
        },
      },
      parcel: {
        weight_kg: ENV.DEFAULT_WEIGHT_KG,
        length_cm,
        width_cm,
        height_cm,
      },
      ...(ENV.SPRO_SERVICE ? { service: ENV.SPRO_SERVICE } : {}),
    };

    // Crea spedizione
    const createRes = await fetch(`${ENV.SPRO_BASE}/create-label`, {
      method: "POST",
      headers: sproAuthHeaders(),
      body: JSON.stringify(payload),
    });

    const ct = (createRes.headers.get("content-type") || "").toLowerCase();
    const raw = await createRes.text();

    if (!ct.includes("application/json"))
      return bad(502, "spro-create-non-json", {
        status: createRes.status,
        snippet: raw.slice(0, 400),
      });

    let js: any;
    try {
      js = JSON.parse(raw);
    } catch {}
    if (!createRes.ok || !js)
      return bad(502, "spro-create-failed", {
        status: createRes.status,
        body: js || raw.slice(0, 400),
      });

    const reference: string =
      js?.order || js?.reference || js?.shipment || js?.shipment_number || "";
    let labelUrl: string | null = null;
    if (reference) {
      try {
        labelUrl = await sproGetLabel(reference);
      } catch {}
    }

    // Metafields: spedirepro.reference + spedirepro.ldv_url
    const metaRes = await setOrderMetafields(orderGid, {
      reference: reference || "",
      ...(labelUrl ? { ldv_url: labelUrl } : {}),
    });
    if (!(metaRes as any).ok) {
      // log silenzioso
      console.log("metafieldsSet error", metaRes);
    }

    // Tag: SPRO-CREATE -> SPRO-SENT
    await replaceTag(orderId, "SPRO-CREATE", "SPRO-SENT");

    return ok({
      status: "spro-label-created",
      order: name,
      reference: reference || null,
      label: labelUrl || null,
    });
  } catch (err: any) {
    console.error("orders-updated crash:", err?.stack || String(err));
    return bad(502, "edge-crash", { message: String(err?.message || err) });
  }
}
