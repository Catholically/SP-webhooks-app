// api/webhooks/orders-updated.ts
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * ENV richieste:
 * - SPRO_API_BASE=https://www.spedirepro.com/public-api/v1
 * - SPRO_API_TOKEN=<chiave API SpedirePro>
 * - SPRO_TRIGGER_TAG=SPRO-CREATE
 * - SPRO_WEBHOOK_TOKEN=<opzionale, per sicurezza query ?token=...>
 */

const SPRO_BASE =
  (process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1").replace(
    /\/+$/,
    ""
  );
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || "";
const TRIGGER_TAG = String(process.env.SPRO_TRIGGER_TAG || "SPRO-CREATE").toLowerCase();
const INBOUND_TOKEN = process.env.SPRO_WEBHOOK_TOKEN || "";

// ---- Tipi Shopify ----
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
  total_weight?: number;
  line_items: Array<{
    id: number;
    title: string;
    quantity: number;
    grams: number;
    sku?: string;
    product_type?: string;
    price: string;
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

function gramsToKg(grams?: number) {
  const g = Math.max(0, Number(grams || 0));
  return +(g / 1000).toFixed(3);
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

async function sproFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (!SPRO_TOKEN) throw new Error("Missing SPRO_API_TOKEN");
  const url = `${SPRO_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Api-Key": SPRO_TOKEN,
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`[SPRO] ${path} -> ${res.status} ${res.statusText} ${text?.slice(0, 300)}`);
    throw new Error(`SPRO ${path} failed: ${res.status}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // @ts-ignore compat
    return text as T;
  }
}

// ---- Costruzione payload ----
function buildCreateLabelPayload(order: ShopifyOrder) {
  const addr = order.shipping_address || {};
  const items = selectItems(order);
  const totalGrams = items.reduce(
    (s, li) => s + (Number(li.grams || 0) * Number(li.quantity || 0)),
    0
  );
  const weightKg = gramsToKg(totalGrams || order.total_weight || 0) || 0.1;

  return {
    merchant_reference: order.name,
    include_return_label: false,
    courier_fallback: true,
    book_pickup: false,
    // mittente obbligatorio
    sender: {
      name: "Catholically",
      address1: "Via di Porta Angelica 23",
      city: "Roma",
      province: "RM",
      postcode: "00193",
      country: "IT",
      phone: "+3906123456",
      email: "info@catholically.com",
    },
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

// Stub fulfillment Shopify
async function fulfillOnShopify(order: ShopifyOrder, created: any) {
  const tracking =
    created?.tracking ||
    created?.label?.tracking_number ||
    created?.tracking_number ||
    "";
  const tracking_url =
    created?.tracking_url ||
    created?.label?.tracking_url ||
    created?.label?.link ||
    "";
  const labelUrl = created?.label?.url || created?.label?.link || "";

  console.log(
    `[SHOPIFY] ready to fulfill ${order.name} tracking=${tracking} url=${tracking_url} label=${labelUrl}`
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (INBOUND_TOKEN) {
    const q = String(req.query?.token || "");
    if (q && q !== INBOUND_TOKEN) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
  }

  try {
    const order = req.body as ShopifyOrder;
    if (!order?.id) {
      res.status(200).json({ ok: true, skipped: "no-order" });
      return;
    }

    if (!hasTriggerTag(order.tags)) {
      res.status(200).json({ ok: true, skipped: "no-trigger-tag" });
      return;
    }

    console.log("[ORD-UPD] start", { id: order.id, name: order.name, tags: order.tags });

    const payload = buildCreateLabelPayload(order);
    console.log("[SPRO] create-label payload", {
      merchant_reference: payload.merchant_reference,
      weight: payload.parcel.weight,
      city: payload.recipient.city,
      country: payload.recipient.country,
    });

    const created = await sproFetch<any>("/create-label", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    console.log("[SPRO] create-label response", created?.order || created);

    await fulfillOnShopify(order, created);

    res.status(200).json({ ok: true, created });
  } catch (err: any) {
    const msg = String(err?.message || err);
    res.status(500).json({ ok: false, error: msg });
  }
}
