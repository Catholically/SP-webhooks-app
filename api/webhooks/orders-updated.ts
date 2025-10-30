// api/webhooks/orders-updated.ts
import type { NextApiRequest, NextApiResponse } from "next";

/** ENV richieste
 * SPRO_API_BASE=https://www.spedirepro.com/public-api/v1
 * SPRO_API_TOKEN=<X-Api-Key SpedirePro>
 * SPRO_TRIGGER_TAG=SPRO-CREATE
 * SHOPIFY_SHOP=<mystore.myshopify.com>
 * SHOPIFY_ACCESS_TOKEN=<Admin API token>
 */
const SPRO_BASE = (process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1").replace(/\/+$/,"");
const SPRO_TOKEN = process.env.SPRO_API_TOKEN || "";
const TRIGGER_TAG = String(process.env.SPRO_TRIGGER_TAG || "SPRO-CREATE").toLowerCase();

const SHOP = String(process.env.SHOPIFY_SHOP || "");
const SHOP_TOKEN = String(process.env.SHOPIFY_ACCESS_TOKEN || "");
const API_VER = "2024-10";

// default pacco
const DEF_WIDTH_CM = 20;
const DEF_HEIGHT_CM = 12;
const DEF_DEPTH_CM = 5;
const DEF_MIN_WEIGHT_KG = 0.5;

// tipi minimi
type ShopifyAddress = {
  first_name?: string;
  last_name?: string;
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  province_code?: string;
  zip?: string;
  country?: string;
  country_code?: string;
  phone?: string;
};
type LineItem = {
  id: number;
  title: string;
  quantity: number;
  grams: number;
  sku?: string;
  product_type?: string;
  price: string;
  name?: string;
};
type ShopifyOrder = {
  id: number;
  name: string;
  tags?: string;
  email?: string;
  total_weight?: number;
  line_items: LineItem[];
  shipping_address?: ShopifyAddress;
};

// util
function hasTriggerTag(tags?: string) {
  return Boolean(tags?.split(",").map((t) => t.trim().toLowerCase()).includes(TRIGGER_TAG));
}
function gramsToKg(g?: number) {
  return +((Math.max(0, g || 0)) / 1000).toFixed(3);
}
function selectItems(o: ShopifyOrder) {
  const EX_TYPES = new Set(["ups", "insurance"]);
  const EX_NAMES = new Set(["tip"]);
  return o.line_items.filter((li) => {
    const pt = (li.product_type || "").toLowerCase().trim();
    const nm = (li.name || li.title || "").toLowerCase().trim();
    return !EX_TYPES.has(pt) && !EX_NAMES.has(nm);
  });
}
async function shopifyAdmin(path: string, init: RequestInit = {}) {
  if (!SHOP || !SHOP_TOKEN) throw new Error("Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN");
  const url = `https://${SHOP}/admin/api/${API_VER}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers = {
    "X-Shopify-Access-Token": SHOP_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`[SHOPIFY] ${path} -> ${res.status} ${res.statusText} ${text?.slice(0, 300)}`);
    throw new Error(`SHOPIFY ${path} failed: ${res.status}`);
  }
  return text ? JSON.parse(text) : {};
}
async function sproFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (!SPRO_TOKEN) throw new Error("Missing SPRO_API_TOKEN");
  const url = `${SPRO_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers = { "Content-Type": "application/json", Accept: "application/json", "X-Api-Key": SPRO_TOKEN, ...(init.headers || {}) };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail: any = {};
    try { detail = JSON.parse(text); } catch {}
    const msg = detail?.error?.message || detail?.message || res.statusText;
    const code = detail?.error?.code || detail?.code || res.status;
    console.error(`[SPRO] ${path} -> ${res.status} ${msg} (code:${code})`);
    if (String(code) === "1011" || /credit/i.test(String(msg))) {
      const e: any = new Error("SPRO_NO_CREDITS");
      e.code = 1011;
      e.detail = detail;
      throw e;
    }
    throw new Error(`SPRO ${path} failed: ${res.status}`);
  }
  try { return JSON.parse(text) as T; } catch { /* @ts-ignore */ return text as T; }
}

// country map -> ISO2
const countryMap: Record<string, string> = {
  italy: "IT",
  "united states": "US",
  usa: "US",
  france: "FR",
  germany: "DE",
  spain: "ES",
  canada: "CA",
  poland: "PL",
  portugal: "PT",
  switzerland: "CH",
  "united kingdom": "GB",
};
function normalizeCountry(a: ShopifyAddress) {
  const c = (a.country_code || a.country || "").trim();
  if (c.length === 2) return c.toUpperCase();
  return countryMap[c.toLowerCase()] || "US";
}

// province US/CA
const US_STATE: Record<string, string> = {
  alabama: "AL", al: "AL", alaska: "AK", ak: "AK", arizona: "AZ", az: "AZ", california: "CA", ca: "CA",
  colorado: "CO", co: "CO", connecticut: "CT", ct: "CT", delaware: "DE", de: "DE", florida: "FL", fl: "FL",
  georgia: "GA", ga: "GA", hawaii: "HI", hi: "HI", idaho: "ID", id: "ID", illinois: "IL", il: "IL",
  indiana: "IN", in: "IN", iowa: "IA", ia: "IA", kansas: "KS", ks: "KS", kentucky: "KY", ky: "KY",
  louisiana: "LA", la: "LA", maine: "ME", me: "ME", maryland: "MD", md: "MD", massachusetts: "MA", ma: "MA",
  michigan: "MI", mi: "MI", minnesota: "MN", mn: "MN
