// api/webhooks/spedirepro.ts
import type { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: { bodyParser: true }, // forza il JSON parser di Next
};

const SHOP = process.env.SHOPIFY_SHOP!;
const SHOP_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const EXPECTED_TOKEN = process.env.SPRO_WEBHOOK_TOKEN || "";

// ---- utils
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

function getToken(req: NextApiRequest) {
  return String(
    (req.query?.token as string) ||
    req.headers["x-webhook-token"] ||
    ""
  );
}

function safeParseBody(req: NextApiRequest): any {
  // Se Next ha già parsato, req.body è un object
  const b: any = (req as any).body;
  if (!b) return {};
  if (typeof b === "object" && !Buffer.isBuffer(b)) return b;
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { throw new Error("Invalid JSON"); }
  }
  // Buffer o altro: prova a convertire
  try {
    const text = Buffer.isBuffer(b) ? b.toString("utf8") : String(b);
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Invalid JSON");
  }
}

// ---- handler
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // healthcheck
  if (req.method === "GET") return res.status(200).json({ ok: true, ping: "spedirepro" });

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  try {
    // auth
    const token = getToken(req);
    if (!EXPECTED_TOKEN || token !== EXPECTED_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // parse body
    let w: any;
    try {
      w = safeParseBody(req);
    } catch (e: any) {
      console.error("[SPRO-WH] parse error", e?.message);
      return res.status(500).json({ ok: false, error: "Invalid JSON" });
    }

    console.log("[SPRO-WH] headers", req.headers);
    console.log("[SPRO-WH] body", JSON.stringify(w).slice(0, 2000));

    // campi principali
    const name = String(w.merchant_reference || "").trim();
    if (!name) return res.status(200).json({ ok: true, skipped: "no-merchant_reference" });

    const trackingNumber = w.tracking || w.tracking_number || "";
    const trackingUrl = w.tracking_url || "";
    const labelUrl = (w.label && (w.label.url || w.label.link)) || "";

    // trova ordine per name
    const search: any = await shopifyAdmin("/orders.json", { method: "GET" as any, headers: {}, body: undefined, });
    // NB: l'endpoint /orders.json con query name va così:
    const searchByName: any = await shopifyAdmin(`/orders.json?name=${encodeURIComponent(name)}`, { method: "GET" as any });
    const order = searchByName?.orders?.[0];
    if (!order) return res.status(200).json({ ok: true, skipped: "order-not-found" });

    // crea fulfillment (se abbiamo almeno il tracking number)
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

    // salva url etichetta come metafield
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

    return res.status(200).json({ ok: true, order_id: order.id, tracking: trackingNumber || null, label: labelUrl || null });
  } catch (err: any) {
    console.error("[SPRO-WH] error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
