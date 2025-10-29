import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

// ---------- HMAC ----------
function verifyHmac(raw: string, hmac: string, secret: string) {
  const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac || "")); }
  catch { return false; }
}

// ---------- Utils peso/parti ----------
function toKg(grams?: number) {
  const g = Number(grams || 0);
  const kg = g > 0 ? g / 1000 : 0.05;
  return Math.max(0.01, Number(kg.toFixed(3)));
}
function defaultParcel(order: any) {
  const totalGrams =
    (order?.line_items || []).reduce((s: number, it: any) => s + (it.grams || 0), 0) ||
    order?.total_weight || 0;
  return { weight: toKg(totalGrams), length: 7, width: 8, height: 3 };
}
function buildParties(order: any) {
  const to = order.shipping_address || {};
  return {
    consignee: {
      country: to.country_code, city: to.city, zip: to.zip,
      province: to.province_code || to.province || "",
      consigneeAddressLine1: to.address1 || "",
      consigneeAddressLine2: to.address2 || "",
      consigneeAddressLine3: "",
      contactName: `${to.first_name || ""} ${to.last_name || ""}`.trim(),
      phone: to.phone || order.phone || "", email: order.email || "",
    },
    sender: {
      country: process.env.SENDER_COUNTRY || "IT",
      city: process.env.SENDER_CITY || "Roma",
      zip: process.env.SENDER_ZIP || "00100",
      province: process.env.SENDER_PROV || "RM",
      senderAddressLine1: process.env.SENDER_ADDR1 || "",
      senderAddressLine2: process.env.SENDER_ADDR2 || "",
      senderAddressLine3: "",
      contactName: process.env.SENDER_NAME || "Catholically",
      phone: process.env.SENDER_PHONE || "", email: process.env.SENDER_EMAIL || "",
    },
  };
}

// ---------- Spedire Pro ----------
async function spLogin() {
  const r = await fetch(`${process.env.SPEDIREPRO_BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.SPEDIREPRO_USER, password: process.env.SPEDIREPRO_PASS }),
  });
  if (!r.ok) throw new Error(`SpedirePro login failed: ${r.status}`);
  const j = await r.json();
  if (!j.token) throw new Error("SpedirePro login missing token");
  return j.token;
}
async function createLabelForOrder(order: any) {
  const token = await spLogin();
  const simPayload = {
    externalReference: order.name,
    externalId: String(order.id),
    ...buildParties(order),
    parcels: [defaultParcel(order)],
    // customs: {...} // se extra-UE
  };
  const simRes = await fetch(`${process.env.SPEDIREPRO_BASE}/api/v1/simulazione`, {
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

  const makeRes = await fetch(`${process.env.SPEDIREPRO_BASE}/api/v1/spedizione/${encodeURIComponent(simulationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tariffCode, labelFormat: 0 }), // 0=PDF, 1=GIF, 2=ZPL
  });
  if (!makeRes.ok) throw new Error(`shipment create failed: ${makeRes.status}`);
  const made = await makeRes.json();

  const tracking =
    made.tracking || made.trackingNumber || made.shipment?.tracking || made?.data?.tracking;
  const trackingUrl =
    made.tracking_url || made.trackingUrl || made.shipment?.trackingUrl || made?.data?.trackingUrl;
  const labelUrl =
    made.label_url || made.labelUrl || made.shipment?.labelUrl || made?.data?.labelUrl;
  if (!tracking || !labelUrl) throw new Error("missing tracking/labelUrl");
  return { tracking, trackingUrl: trackingUrl || null, labelUrl };
}

// ---------- Shopify Admin REST ----------
const SHOP = process.env.SHOPIFY_ADMIN_DOMAIN!;
const AT   = process.env.SHOPIFY_ADMIN_TOKEN!;
const API  = "2025-10";

async function shopifyGetOrder(id: number) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/orders/${id}.json`, {
    headers: { "X-Shopify-Access-Token": AT },
  });
  if (!r.ok) throw new Error(`shopify get order failed: ${r.status}`);
  return (await r.json()).order;
}
async function shopifyPutOrderTags(id: number, tags: string[]) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/orders/${id}.json`, {
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
  const r = await fetch(`https://${SHOP}/admin/api/${API}/metafields.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": AT, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`shopify metafield failed: ${r.status}`);
}

// Disattiva parsing automatico per avere RAW body
export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

  // Evento
  const ev = JSON.parse(raw);
  const orderId = Number(ev.id);
  const name = String(ev.name || "");
  const tags = String(ev.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean);

  const hasTrigger = tags.includes("CREATE-LABEL");
  const alreadyDone = tags.includes("LABEL-DONE");
  if (!hasTrigger || alreadyDone) return res.status(200).json({ ok: true, skipped: true });

  // 1) Crea etichetta
  const label = await createLabelForOrder(ev);

  // 2) Scrivi metafield su ordine
  await shopifyCreateOrderMetafield(orderId, {
    tracking: label.tracking,
    tracking_url: label.trackingUrl,
    label_url: label.labelUrl,
    source: "spedirepro",
    order_name: name,
  });

  // 3) Aggiungi LABEL-DONE (presa la versione più recente dei tag)
  const orderFresh = await shopifyGetOrder(orderId);
  const nowTags: string[] = String(orderFresh.tags || "")
    .split(",").map((t: string) => t.trim()).filter(Boolean);
  const newTags = Array.from(new Set([...nowTags, "LABEL-DONE"]));
  await shopifyPutOrderTags(orderId, newTags);

  // 4) OK
  return res.status(200).json({ ok: true, tracking: label.tracking, label_url: label.labelUrl });
}
