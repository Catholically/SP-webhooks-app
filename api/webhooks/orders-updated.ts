import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

export const config = { api: { bodyParser: false } };
const API_VER = "2025-10";

/* ---------------- HMAC Shopify ---------------- */
function verifyHmac(raw: string, hmac: string, secret: string) {
  const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac || "")); }
  catch { return false; }
}

/* ---------------- Utils ---------------- */
function toKg(grams?: number) {
  const g = Number(grams || 0);
  const kg = g > 0 ? g / 1000 : 0.05;
  return Math.max(0.01, Number(kg.toFixed(3)));
}
function defaultParcel(order: any) {
  const totalGrams =
    (order?.line_items || []).reduce((s: number, it: any) => s + (it.grams || 0), 0) ||
    order?.total_weight || 0;
  // spedirepro public-api usa weight in KG e dimensioni in CM (assunti standard)
  return { width: 8, height: 3, depth: 7, weight: Math.max(1, Math.round(toKg(totalGrams))) };
}
function needsCustoms(destCountry?: string) {
  const from = (process.env.SENDER_COUNTRY || "IT").toUpperCase();
  return String(destCountry || "").toUpperCase() !== from;
}
async function safeFetch(url: string, init?: RequestInit) {
  try { return await fetch(url, init); }
  catch (err: any) {
    console.error("FETCH_ERROR", url, err?.cause?.code || err?.message || String(err));
    throw err;
  }
}

/* ---------------- SpedirePro (public-api) ----------------
   BASE: https://www.spedirepro.com/public-api
   Auth: header X-Api-Key
   Endpoints: POST /v1/get-quotes  |  POST /v1/create-label
---------------------------------------------------------- */
async function createLabelForOrder(order: any) {
  const base   = process.env.SPEDIREPRO_BASE!;   // es. https://www.spedirepro.com/public-api
  const apikey = process.env.SPEDIREPRO_APIKEY!;
  const to = order.shipping_address || {};
  const pkg = defaultParcel(order);

  // 1) quote (valida payload e recupera id tariffa)
  const quotePayload = {
    from: {
      country: process.env.SENDER_COUNTRY || "IT",
      city:    process.env.SENDER_CITY || "Roma",
      postcode: process.env.SENDER_ZIP || "00100",
    },
    to: {
      country: to.country_code,
      city:    to.city,
      postcode: to.zip,
    },
    packages: [pkg],
  };
  const q = await safeFetch(`${base}/v1/get-quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apikey },
    body: JSON.stringify(quotePayload),
  });
  if (!q.ok) throw new Error(`get-quotes failed: ${q.status}`);
  const quotes = await q.json();
  const best = Array.isArray(quotes) ? quotes[0] : undefined;
  if (!best?.id) throw new Error("no quotes returned");

  // 2) create-label
  const createPayload: any = {
    merchant_reference: String(order.name || order.id),
    include_return_label: false,
    book_pickup: false,
    courier_fallback: true,
    sender: {
      name: process.env.SENDER_NAME || "Catholically",
      country: process.env.SENDER_COUNTRY || "IT",
      city: process.env.SENDER_CITY || "Roma",
      postcode: process.env.SENDER_ZIP || "00100",
      province: process.env.SENDER_PROV || "RM",
      street: process.env.SENDER_ADDR1 || "",
      email: process.env.SENDER_EMAIL || "",
      phone: process.env.SENDER_PHONE || "",
    },
    receiver: {
      name: `${to.first_name || ""} ${to.last_name || ""}`.trim() || "Receiver",
      country: to.country_code,
      city: to.city,
      postcode: to.zip,
      province: to.province_code || to.province || "",
      street: to.address1 || "",
      email: order.email || "",
      phone: to.phone || order.phone || "",
    },
    packages: [pkg],
    quote_id: best.id, // usa la tariffa migliore restituita da get-quotes
  };

  if (needsCustoms(to.country_code)) {
    createPayload.customs_items = [
      { description: "Religious articles", quantity: 1, value: 12.0, hs_code: "7117.19", weight: 0.02 }
    ];
    createPayload.customs_incoterm = "DDU";
    createPayload.customs_currency = "EUR";
  }

  const res = await safeFetch(`${base}/v1/create-label`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apikey },
    body: JSON.stringify(createPayload),
  });
  if (!res.ok) throw new Error(`create-label failed: ${res.status}`);
  const out = await res.json();

  const tracking    = out?.tracking_number || out?.tracking || out?.data?.tracking;
  const labelUrl    = out?.label?.url || out?.label_url || out?.data?.label_url;
  const trackingUrl = out?.tracking_url || out?.data?.tracking_url || null;
  if (!tracking || !labelUrl) throw new Error("missing tracking/labelUrl");

  return { tracking, trackingUrl, labelUrl };
}

/* ---------------- Shopify Admin REST ---------------- */
const SHOP = process.env.SHOPIFY_ADMIN_DOMAIN!;
const AT   = process.env.SHOPIFY_ADMIN_TOKEN!;
async function shopifyGetOrder(id: number) {
  const r = await safeFetch(`https://${SHOP}/admin/api/${API_VER}/orders/${id}.json`, {
    headers: { "X-Shopify-Access-Token": AT },
  });
  if (!r.ok) throw new Error(`shopify get order failed: ${r.status}`);
  return (await r.json()).order;
}
async function shopifyPutOrderTags(id: number, tags: string[]) {
  const r = await safeFetch(`https://${SHOP}/admin/api/${API_VER}/orders/${id}.json`, {
    method: "PUT",
    headers: { "X-Shopify-Access-Token": AT, "Content-Type": "application/json" },
    body: JSON.stringify({ order: { id, tags: tags.join(", ") } }),
  });
  if (!r.ok) throw new Error(`shopify put order failed: ${r.status}`);
}
async function shopifyCreateOrderMetafield(orderId: number, data: any) {
  const payload = {
    metafield: {
      owner_id: orderId,
      owner_resource: "order",
      namespace: "shipping",
      key: "label_info",
      type: "json",
      value: JSON.stringify(data),
    },
  };
  const r = await safeFetch(`https://${SHOP}/admin/api/${API_VER}/metafields.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": AT, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`shopify metafield failed: ${r.status}`);
}

/* ---------------- Handler ---------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(404).end("Not Found");

    // RAW body per HMAC
    const raw = await new Promise<string>((resolve, reject) => {
      let data = ""; req.on("data", c => data += c);
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

    // Verifica HMAC
    const hmac = req.headers["x-shopify-hmac-sha256"] as string;
    if (!verifyHmac(raw, hmac, process.env.SHOPIFY_WEBHOOK_SECRET || "")) {
      return res.status(401).end("unauthorized");
    }

    // Evento ordine
    const ev = JSON.parse(raw);
    const orderId = Number(ev.id);
    const name = String(ev.name || "");
    const tags = String(ev.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean);

    const hasTrigger = tags.includes("CREATE-LABEL");
    const alreadyDone = tags.includes("LABEL-DONE");
    if (!hasTrigger || alreadyDone) return res.status(200).json({ ok: true, skipped: true });

    // 1) Crea etichetta su SpedirePro
    const label = await createLabelForOrder(ev);

    // 2) Scrivi metafield
    await shopifyCreateOrderMetafield(orderId, {
      tracking: label.tracking,
      tracking_url: label.trackingUrl,
      label_url: label.labelUrl,
      source: "spedirepro",
      order_name: name,
    });

    // 3) Aggiungi LABEL-DONE (idempotenza)
    const fresh = await shopifyGetOrder(orderId);
    const nowTags: string[] = String(fresh.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean);
    const newTags = Array.from(new Set([...nowTags, "LABEL-DONE"]));
    await shopifyPutOrderTags(orderId, newTags);

    return res.status(200).json({ ok: true, tracking: label.tracking, label_url: label.labelUrl });
  } catch (err: any) {
    console.error("WEBHOOK ERROR", err?.message || err, err?.stack);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
