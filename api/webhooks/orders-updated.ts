// api/webhooks/orders-updated.ts
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * ENV supportate (usa quelle che già hai):
 * - SPRO_API_BASE            (preferita)  es: https://www.spedirepro.com/public-api/v1
 * - SPEDIREPRO_BASE          (alias)
 * - SPRO_API_TOKEN           (preferita)
 * - SPEDIREPRO_API_TOKEN     (alias)
 * - SPRO_WEBHOOK_TOKEN       (per eventuale token di sicurezza inbound)
 * - SPEDIREPRO_WEBHOOK_TOKEN (alias)
 * - SPRO_TRIGGER_TAG         (es: ROME-WH, MILAN-WH, SPRO-CREATE)
 */
const SPRO_BASE =
  (process.env.SPRO_API_BASE || process.env.SPEDIREPRO_BASE || "").replace(/\/+$/, "") ||
  "https://www.spedirepro.com/public-api/v1";

const SPRO_TOKEN =
  process.env.SPRO_API_TOKEN ||
  process.env.SPEDIREPRO_API_TOKEN || // alias
  process.env.SPRO_TOKEN || "";        // fallback se già esistente nel tuo progetto

const WEBHOOK_TOKEN =
  process.env.SPRO_WEBHOOK_TOKEN ||
  process.env.SPEDIREPRO_WEBHOOK_TOKEN ||
  "";

const TRIGGER_TAG = (process.env.SPRO_TRIGGER_TAG || "SPRO-CREATE").toLowerCase();

// ---- Tipi Shopify minimi ----
type ShopifyAddress = {
  first_name?: string;
  last_name?: string;
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  phone?: string;
};

type ShopifyOrder = {
  id: number;
  name: string;
  tags?: string;
  email?: string;
  currency?: string;
  total_weight?: number; // grams
  line_items: Array<{
    id: number;
    title: string;
    quantity: number;
    grams: number; // per unit
    sku?: string;
    product_exists?: boolean;
    product_id?: number;
    vendor?: string;
    price: string;
    product_type?: string;
    name?: string;
  }>;
  shipping_address?: ShopifyAddress;
};

// ---- Util ----
function hasTriggerTag(tags?: string): boolean {
  if (!tags) return false;
  return tags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .some((t) => t === TRIGGER_TAG);
}

function selectItems(order: ShopifyOrder) {
  const EXCLUDED_TYPES = new Set(["ups", "insurance"]);
  const EXCLUDED_NAMES = new Set(["tip"]);
  return order.line_items.filter((li) => {
    const pt = (li.product_type || "").trim().toLowerCase();
    const nm = (li.name || li.title || "").trim().toLowerCase();
    if (EXCLUDED_TYPES.has(pt)) return false;
    if (EXCLUDED_NAMES.has(nm)) return false;
    return true;
  });
}

function gramsToKg(grams?: number) {
  const g = Math.max(0, grams || 0);
  return +(g / 1000).toFixed(3);
}

async function sproFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (!SPRO_TOKEN) throw new Error("Missing SPRO_API_TOKEN");
  const url = `${SPRO_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SPRO_TOKEN}`,
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`SPRO ${path} failed: ${res.status} ${res.statusText} ${text ? "- " + text : ""}`);
    console.error(`[SPRO] ${err.message}`);
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  // @ts-ignore compat
  return (await res.text()) as T;
}

async function getBestQuote(payload: any) {
  try {
    const quotes = await sproFetch<any>("/get-quotes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const list = Array.isArray(quotes?.rates) ? quotes.rates : quotes;
    if (!Array.isArray(list) || list.length === 0) throw new Error("No quotes");
    list.sort((a: any, b: any) => Number(a.total) - Number(b.total));
    return list[0];
  } catch {
    const sim = await sproFetch<any>("/simulation", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const list = Array.isArray(sim?.rates) ? sim.rates : sim;
    if (!Array.isArray(list) || list.length === 0) throw new Error("No simulation rates");
    list.sort((a: any, b: any) => Number(a.total) - Number(b.total));
    return list[0];
  }
}

async function createShipment(payload: any) {
  const created = await sproFetch<any>("/create", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return created;
}

function buildSproPayload(order: ShopifyOrder) {
  const addr = order.shipping_address || {};
  const items = selectItems(order);

  const totalGrams = items.reduce((s, li) => s + (li.grams || 0) * (li.quantity || 0), 0);
  const weightKg = gramsToKg(totalGrams || order.total_weight || 0) || 0.1;

  return {
    merchant_reference: order.name,
    reference: String(order.id),
    recipient: {
      name:
        addr.name ||
        [addr.first_name, addr.last_name].filter(Boolean).join(" ").trim() ||
        "Customer",
      address1: addr.address1 || "",
      address2: addr.address2 || "",
      city: addr.city || "",
      province: addr.province || "",
      postcode: addr.zip || "",
      country: addr.country || "",
      phone: addr.phone || "",
      email: order.email || "",
    },
    parcel: {
      weight: weightKg,
      length: 22,
      width: 16,
      height: 4,
    },
    contents: items.map((li) => ({
      description: li.title,
      quantity: li.quantity,
      sku: li.sku || String(li.id),
      unit_price: Number(li.price || 0),
      weight: gramsToKg((li.grams || 0) * (li.quantity || 0)),
    })),
  };
}

// Stub: integra con il tuo admin Shopify se necessario
async function fulfillOnShopify(order: ShopifyOrder, sproResult: any) {
  const tracking = sproResult?.tracking || "";
  const tracking_url =
    sproResult?.tracking_url ||
    sproResult?.label?.tracking_url ||
    sproResult?.label?.link ||
    "";
  const labelUrl = sproResult?.label?.url || sproResult?.label?.link || "";

  console.log(`[SHOPIFY] fulfill ${order.name} tracking=${tracking} url=${tracking_url} label=${labelUrl}`);

  // Esempio:
  // const { admin } = await authenticate.admin(request, { isOnline: false });
  // await admin.rest.post({ path: "/fulfillments.json", data:{ fulfillment:{ order_id: order.id, tracking_number: tracking, tracking_url, notify_customer:true } }});
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    // opzionale: verifica token se lo invii come query / header
    const qToken = (req.query?.token as string) || "";
    if (WEBHOOK_TOKEN && qToken && qToken !== WEBHOOK_TOKEN) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const order = req.body as ShopifyOrder;
    if (!order?.id) {
      res.status(200).json({ ok: true, skipped: "no-order" });
      return;
    }

    if (!hasTriggerTag(order.tags)) {
      res.status(200).json({ ok: true, skipped: "no-trigger-tag" });
      return;
    }

    const payload = buildSproPayload(order);

    const rate = await getBestQuote(payload);
    console.log("[SPRO] chosen rate:", rate?.service || rate?.code || rate?.carrier || "unknown");

    const created = await createShipment({
      ...payload,
      service: rate?.service || rate?.code || undefined,
      carrier: rate?.carrier || undefined,
      total: rate?.total || undefined,
    });

    await fulfillOnShopify(order, created);

    res.status(200).json({ ok: true, created });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes("401")) {
      res.status(500).json({ ok: false, error: "SPRO auth 401. Verifica SPRO_API_TOKEN." });
      return;
    }
    if (msg.includes("404")) {
      res.status(500).json({
        ok: false,
        error: "SPRO 404. Verifica SPRO_API_BASE e path (/get-quotes, /simulation, /create).",
      });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
}
