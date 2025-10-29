// api/webhooks/orders-updated.ts
// Runtime: Vercel/Next API route or Remix/Route module on Node 18+
// Dipendenze esterne: nessuna. Se hai helper di Shopify (es. authenticate.admin) vedi TODO più sotto.

import type { NextApiRequest, NextApiResponse } from "next";

/**
 * ENV richieste:
 * - SPRO_API_BASE = https://www.spedirepro.com/public-api/v1
 * - SPRO_API_TOKEN = <Bearer token>
 * - SPRO_TRIGGER_TAG = <es. ROME-WH o MILAN-WH o SPRO-CREATE>
 * - SHOPIFY_WEBHOOK_SECRET = <facoltativo, per verifica HMAC>
 */
const SPRO_BASE =
  process.env.SPRO_API_BASE?.replace(/\/+$/, "") ||
  "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || "";
const TRIGGER_TAG = (process.env.SPRO_TRIGGER_TAG || "SPRO-CREATE").toLowerCase();

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
  total_weight?: number; // in grams
  line_items: Array<{
    id: number;
    title: string;
    quantity: number;
    grams: number; // per unit, grams
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

function hasTriggerTag(tags?: string): boolean {
  if (!tags) return false;
  return tags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .some((t) => t === TRIGGER_TAG);
}

function selectItems(order: ShopifyOrder) {
  // Esclusioni note: Product type "UPS", "Insurance", Product name "TIP"
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

async function sproFetch<T = any>(
  path: string,
  init: RequestInit & { retryOn404?: boolean } = {}
): Promise<T> {
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
    const err = new Error(
      `SPRO ${path} failed: ${res.status} ${res.statusText} ${text ? "- " + text : ""}`
    );
    // Log sintetico
    console.error(`[SPRO] ${err.message}`);
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  // per compatibilità se l'API restituisse HTML o altro
  // @ts-ignore
  return (await res.text()) as T;
}

/**
 * 1) Ottiene i preventivi
 *   - tenta /get-quotes
 *   - fallback a /simulation se necessario
 */
async function getBestQuote(payload: any) {
  try {
    const quotes = await sproFetch<any>("/get-quotes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const list = Array.isArray(quotes?.rates) ? quotes.rates : quotes;
    if (!Array.isArray(list) || list.length === 0) throw new Error("No quotes");
    // scegli il più economico
    list.sort((a: any, b: any) => Number(a.total) - Number(b.total));
    return list[0];
  } catch (e: any) {
    // fallback a /simulation
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

/**
 * 2) Crea spedizione
 */
async function createShipment(payload: any) {
  const created = await sproFetch<any>("/create", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return created;
}

/**
 * Costruisce payload SPRO dagli order Shopify
 */
function buildSproPayload(order: ShopifyOrder) {
  const addr = order.shipping_address || {};
  const items = selectItems(order);

  const totalGrams = items.reduce((s, li) => s + (li.grams || 0) * (li.quantity || 0), 0);
  const weightKg = gramsToKg(totalGrams || order.total_weight || 0) || 0.1; // default 0.1 kg

  return {
    merchant_reference: order.name, // es. "#1001"
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
    // pacco unico con peso totale
    parcel: {
      weight: weightKg, // kg
      length: 22, // cm default
      width: 16,
      height: 4,
    },
    // dettagli merce per dogana
    contents: items.map((li) => ({
      description: li.title,
      quantity: li.quantity,
      sku: li.sku || String(li.id),
      unit_price: Number(li.price || 0),
      weight: gramsToKg((li.grams || 0) * (li.quantity || 0)),
    })),
    // opzionali a seconda del tuo account
    // incoterm, insurance, notes, ecc.
  };
}

/**
 * TODO Shopify Fulfillment:
 * Se nel tuo progetto hai un helper tipo `authenticate.admin`,
 * sposta qui la creazione del fulfillment e salvataggio metafield.
 * Qui metto solo stub lato log.
 */
async function fulfillOnShopify(_order: ShopifyOrder, sproResult: any) {
  const tracking = sproResult?.tracking || "";
  const tracking_url =
    sproResult?.tracking_url ||
    sproResult?.label?.tracking_url ||
    sproResult?.label?.link ||
    "";
  const labelUrl = sproResult?.label?.url || sproResult?.label?.link || "";

  console.log(
    `[SHOPIFY] ready to fulfill ${_order.name} tracking=${tracking} url=${tracking_url} label=${labelUrl}`
  );

  // Esempio con REST Admin (pseudocodice):
  // const { admin } = await authenticate.admin(request, { isOnline: false });
  // await admin.rest.post({
  //   path: "/fulfillments.json",
  //   data: { fulfillment: { order_id: _order.id, tracking_number: tracking, tracking_url, notify_customer: true } },
  // });
  // await admin.rest.post({
  //   path: `/orders/${_order.id}/metafields.json`,
  //   data: { metafield: { namespace: "shipping", key: "label_url", type: "single_line_text_field", value: labelUrl } }
  // });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    // Se vuoi verificare HMAC di Shopify, aggiungi qui la verifica con SHOPIFY_WEBHOOK_SECRET.
    const order = req.body as ShopifyOrder;
    if (!order || !order.id) {
      res.status(200).json({ ok: true, skipped: "no-order" });
      return;
    }

    if (!hasTriggerTag(order.tags)) {
      res.status(200).json({ ok: true, skipped: "no-trigger-tag" });
      return;
    }

    const sproPayload = buildSproPayload(order);

    // 1) preventivi
    const bestRate = await getBestQuote(sproPayload);
    console.log("[SPRO] selected rate:", bestRate?.service || bestRate?.carrier || "unknown");

    // 2) crea spedizione
    const createPayload = {
      ...sproPayload,
      service: bestRate?.service || bestRate?.code || undefined,
      carrier: bestRate?.carrier || undefined,
      total: bestRate?.total || undefined,
    };
    const created = await createShipment(createPayload);

    // 3) fulfillment Shopify
    await fulfillOnShopify(order, created);

    res.status(200).json({ ok: true, created });
  } catch (err: any) {
    // Mappa errori frequenti
