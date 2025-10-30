// pages/api/webhooks/spedirepro.ts
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { api: { bodyParser: false } }; // leggiamo RAW

const SHOP = process.env.SHOPIFY_SHOP!;
const SHOP_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const EXPECTED_TOKEN = process.env.SPRO_WEBHOOK_TOKEN || "";

// --- utils ---
async function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJson(text: string): any | null {
  try { return JSON.parse(text); } catch { return null; }
}

async function shopifyAdmin(path: string, init: RequestInit = {}) {
  if (!SHOP || !SHOP_TOKEN) throw new Error("Missing SHOPIFY env");
  const url = `https://${SHOP}/admin/api/2024-10${path.startsWith("/") ? "" : "/"}${path}`;
  const headers = {
    "X-Shopify-Access-Token": SHOP_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`[SHOPIFY] ${path} -> ${res.status} ${res.statusText} ${txt?.slice(0,300)}`);
    throw new Error(`SHOPIFY ${path} failed: ${res.status}`);
  }
  return txt ? JSON.parse(txt) : {};
}

// --- handler ---
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Healthcheck
  if (req.method === "GET") return res.status(200).json({ ok: true, ping: "spedirepro" });
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"method not allowed" });

  // Auth
  const token = String(req.query?.token || req.headers["x-webhook-token"] || "");
  if (!EXPECTED_TOKEN || token !== EXPECTED_TOKEN) {
    return res.status(401).json({ ok:false, error:"unauthorized" });
  }

  // RAW -> JSON
  const raw = await readRawBody(req);
  const rawTrim = raw?.trim?.() ?? raw;
  const body = safeJson(rawTrim);
  if (!body || typeof body !== "object") {
    console.warn("[SPRO-WH] invalid json, raw:", rawTrim?.slice(0,200));
    return res.status(200).json({ ok:true, skipped:"invalid-json", raw_preview: rawTrim?.slice(0,200) || "" });
  }

  console.log("[SPRO-WH] body", JSON.stringify(body).slice(0,2000));

  // Campi tolleranti
  const merchantRef = String(body.merchant_reference || "").trim();         // es. "#35534182025"
  const reference    = String(body.reference || body.id || "").trim();      // id interno SPRO se vuoi salvarlo
  const tracking     = String(body.tracking || body.tracking_number || "").trim();
  const trackingUrl  = String(body.tracking_url || "").trim();
  const labelUrl     = String(body?.label?.url || body?.label?.link || "").trim();

  if (!merchantRef) {
    return res.status(200).json({ ok:true, skipped:"no-merchant_reference" });
  }

  // Trova ordine per name
  const search: any = await shopifyAdmin(`/orders.json?name=${encodeURIComponent(merchantRef)}`, { method: "GET" as any });
  const order = search?.orders?.[0];
  if (!order) {
    return res.status(200).json({ ok:true, skipped:"order-not-found", ref: merchantRef });
  }

  // Crea fulfillment se abbiamo il tracking
  if (tracking) {
    await shopifyAdmin("/fulfillments.json", {
      method: "POST",
      body: JSON.stringify({
        fulfillment: {
          order_id: order.id,
          tracking_number: tracking,
          tracking_url: trackingUrl || undefined,
          notify_customer: true,
        },
      }),
    });
  }

  // Salva metafield utili
  const metafields: Array<{key:string; type:string; value:string}> = [];
  if (reference) metafields.push({ key:"order_id",  type:"single_line_text_field", value: reference });
  if (labelUrl)  metafields.push({ key:"label_url", type:"url",                    value: labelUrl });

  for (const mf of metafields) {
    await shopifyAdmin("/metafields.json", {
      method: "POST",
      body: JSON.stringify({
        metafield: {
          namespace: "spro",
          key: mf.key,
          type: mf.type,
          value: mf.value,
          owner_resource: "order",
          owner_id: order.id,
        },
      }),
    });
  }

  return res.status(200).json({
    ok: true,
    order_id: order.id,
    saved: metafields.map(m => m.key),
    fulfillment: Boolean(tracking),
  });
}
