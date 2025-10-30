// api/webhooks/spedirepro.ts
import type { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: { bodyParser: false }, // leggiamo il raw body a mano
};

const SHOP = process.env.SHOPIFY_SHOP!;
const SHOP_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const EXPECTED_TOKEN = process.env.SPRO_WEBHOOK_TOKEN || "";

// --- utils ---
function getToken(req: NextApiRequest) {
  return String(
    (req.query?.token as string) ||
    req.headers["x-webhook-token"] ||
    ""
  );
}

async function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJsonParse(text: string): any {
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error("Invalid JSON"); }
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
  // Healthcheck semplice anche per GET
  if (req.method === "GET") return res.status(200).json({ ok: true, ping: "spedirepro" });

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  // Auth
  const token = getToken(req);
  if (!EXPECTED_TOKEN || token !== EXPECTED_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    // Leggi raw e prova parse JSON
    const raw = await readRawBody(req);
    let payload: any = {};
    try {
      payload = safeJsonParse(raw);
    } catch (e: any) {
      console.error("[SPRO-WH] parse error:", e?.message, "raw:", raw);
      return res.status(200).json({ ok: true, skipped: "invalid-json", raw: raw?.slice(0,200) || "" });
    }

    console.log("[SPRO-WH] headers", req.headers);
    console.log("[SPRO-WH] body", JSON.stringify(payload).slice(0, 2000));

    // Campi utili (tolleranti)
    const name = String(payload.merchant_reference || "").trim();
    const trackingNumber = payload.tracking || payload.tracking_number || "";
    const trackingUrl = payload.tracking_url || "";
    const labelUrl = payload?.label?.url || payload?.label?.link || "";

    if (!name) {
      return res.status(200).json({ ok: true, skipped: "no-merchant_reference" });
    }

    // Trova ordine per name
    const searchByName: any = await shopifyAdmin(`/orders.json?name=${encodeURIComponent(name)}`, { method: "GET" as any });
    const order = searchByName?.orders?.[0];
    if (!order) return res.status(200).json({ ok: true, skipped: "order-not-found", ref: name });

    // Crea fulfillment se c'è un tracking
    if (trackingNumber) {
      await shopifyAdmin("/fulfillments.json", {
        method: "POST",
        body: JSON.stringify({
          fulfillment: {
            order_id: order.id,
            tracking_number: trackingNumber,
            tracking_url: trackingUrl || undefined,
            notify_customer: true,
          },
        }),
      });
    }

    // Salva URL etichetta come metafield se presente
    if (labelUrl) {
      await shopifyAdmin("/metafields.json", {
        method: "POST",
        body: JSON.stringify({
          metafield: {
            namespace: "spro",
            key: "label_url",
            type: "url",
            value: labelUrl,
            owner_resource: "order",
            owner_id: order.id,
          },
        }),
      });
    }

    return res.status(200).json({
      ok: true,
      order_id: order.id,
      tracking: trackingNumber || null,
      label: labelUrl || null,
    });
  } catch (err: any) {
    console.error("[SPRO-WH] error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
