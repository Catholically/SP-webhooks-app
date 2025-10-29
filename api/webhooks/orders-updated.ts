import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

// ---- CONFIG ----
export const config = { api: { bodyParser: false } };
const API_VER = "2025-10";

// ---- HMAC Shopify ----
function verifyHmac(raw: string, hmac: string, secret: string) {
  const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac || "")); }
  catch { return false; }
}

// ---- Utils ----
function toKg(grams?: number) {
  const g = Number(grams || 0);
  const kg = g > 0 ? g / 1000 : 0.05;
  return Math.max(0.01, Number(kg.toFixed(3)));
}
function defaultParcel(order: any) {
  const totalGrams = (order?.line_items || []).reduce((s: number, it: any) => s + (it.grams || 0), 0) || order?.total_weight || 0;
  return { weight: toKg(totalGrams), length: 7, width: 8, height: 3 };
}
function buildParties(order: any) {
  const to = order.shipping_address || {};
  return {
    consignee: {
      country: to.country_code, city: to.city, zip: to.zip,
      province: to.province_code || to.province || "",
      consigneeAddressLine1: to.address1 || "", consigneeAddressLine2: to.address2 || "", consigneeAddressLine3: "",
      contactName: `${to.first_name || ""} ${to.last_name || ""}`.trim(),
      phone: to.phone || order.phone || "", email: order.email || "",
    },
    sender: {
      country: process.env.SENDER_COUNTRY || "IT",
      city: process.env.SENDER_CITY || "Roma",
      zip: process.env.SENDER_ZIP || "00100",
      province: process.env.SENDER_PROV || "RM",
      senderAddressLine1: process.env.SENDER_ADDR1 || "", senderAddressLine2: process.env.SENDER_ADDR2 || "", senderAddressLine3: "",
      contactName: process.env.SENDER_NAME || "Catholically",
      phone: process.env.SENDER_PHONE || "", email: process.env.SENDER_EMAIL || "",
    },
  };
}
function needsCustoms(destCountry?: string) {
  const from = (process.env.SENDER_COUNTRY || "IT").toUpperCase();
  return String(destCountry || "").toUpperCase() !== from;
}
async function safeFetch(url: string, init?: RequestInit) {
  try {
    const r = await fetch(url, init);
    return r;
  } catch (err: any) {
    console.error("FETCH_ERROR", url, err?.cause?.code || err?.message || String(err));
    throw err;
  }
}

// ---- Spedire Pro (API Key Bearer) ----
async function createLabelForOrder(order: any) {
  const base = process.env.SPEDIREPRO_BASE!;          // es: https://spedirepro.com
  const token = process.env.SPEDIREPRO_APIKEY!;       // chiave API dal pannello
  const to = order.shipping_address || {};

  const simPayload: any = {
    externalReference: order.name,
    externalId: String(order.id),
    ...buildParties(order),
    parcels: [defaultParcel(order)],
  };
  if (needsCustoms(to.country_code)) {
    simPayload.customs = {
      contents: "Religious articles",
      currency: "EUR",
      incoterm: "DDU",
      items: [{ description: "Medal", quantity: 1, weight: 0.02, value: 12.0, hsCode: "7117.19" }],
    };
  }

  const simRes = await safeFetch(`${base}/api/v1/simulazione`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(simPayload),
  });
  if (!simRes.ok) throw new Error(`simulation failed: ${simRes.status}`);
  const sim = await simRes.json();

  const best = sim?.tariffe?.[0] || sim?.rates?.[0];
  const simulationId = sim?.id || sim?.simulationId || best?.simulationId;
  const tariffCode = best?.tariffCode || best?.code;
  if (!simulationId || !tariffCode) throw new Error("missing simulationId/tariffCode");

  const makeRes = await safeFetch(`${base}/api/v1/spedizione/${encodeURIComponent(simulationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tariffCode, labelFormat: 0 }), // 0=PDF, 1=GIF, 2=ZPL
  });
  if (!makeRes.ok) throw new Error(`shipment create failed: ${makeRes.status}`);
  const made = await makeRes.json();

  const tracking   = made.tracking     || made.data?.tracking;
  const trackingUrl= made.tracking_url || made.data?.tracking_url;
  const labelUrl   = made.label_url    || made.data?.label_url;
  if (!tracking || !labelUrl) throw new Error("missing tracking/labelUrl");

  return { tracking, trackingUrl: trackingUrl || null, labelUrl };
}

// ---- Shopify Admin REST ----
const SHOP  = process.env.SHOPIFY_ADMIN_DOMAIN!;
const AT    = process.env.SHOPIFY_ADMIN_TOKEN!;

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
      owner_id: orderId, owner_resource: "order",
      namespace: "shipping", key: "label_info", type: "json",
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

// ---- Handler ----
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(404).end("Not Found");

    // RAW body
    const raw = await new Promise<string>((resolve, reject) => {
      let data = ""; req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data)); req.on("error", reject);
    });

    // HMAC
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

    // 1) Crea etichetta su Spedire Pro
    const label = await createLabelForOrder(ev);

    // 2) Salva metafield su Shopify
    await shopifyCreateOrderMetafield(orderId, {
      tracking: label.tracking,
      tracking_url: label.trackingUrl,
      label_url: label.labelUrl,
      source: "spedirepro",
      order_name: name,
    });

    // 3) Aggiungi LABEL-DONE con idempotenza
    const orderFresh = await shopifyGetOrder(orderId);
    const nowTags: string[] = String(orderFresh.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean);
    const newTags = Array.from(new Set([...nowTags, "LABEL-DONE"]));
    await shopifyPutOrderTags(orderId, newTags);

    return res.status(200).json({ ok: true, tracking: label.tracking, label_url: label.labelUrl });
  } catch (err: any) {
    console.error("WEBHOOK ERROR", err?.message || err, err?.stack);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
