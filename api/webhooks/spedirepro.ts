// api/webhooks/spedirepro.ts
// Next.js Edge runtime
// ENV richieste:
// SHOPIFY_SHOP=holy-trove.myshopify.com
// SHOPIFY_ADMIN_TOKEN=shpat_...
// DEFAULT_CARRIER_NAME=UPS
// SPRO_WEBHOOK_TOKEN=spro_2e9c41c3b4a14c8b9f7d8a1fcd392b72

import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const CARRIER = process.env.DEFAULT_CARRIER_NAME || "UPS";
const WEBHOOK_TOKEN = process.env.SPRO_WEBHOOK_TOKEN;

type SpedireProWebhook = {
  merchant_reference?: string;
  reference?: string;
  tracking?: string;
  tracking_url?: string;
  label?: { link?: string };
};

// --------- Helper GQL con debug non distruttivo ---------

type GQLResult = {
  ok: boolean;
  status: number;
  json?: any;
  text?: string;
  error?: string;
};

async function shopifyGraphQLSafe(query: string, variables?: Record<string, any>): Promise<GQLResult> {
  try {
    const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json: any = undefined;
    try { json = JSON.parse(text); } catch { /* può non essere JSON */ }
    if (!res.ok) {
      return { ok: false, status: res.status, text, error: `HTTP ${res.status}` };
    }
    if (json?.errors?.length) {
      return { ok: false, status: res.status, json, text, error: json.errors.map((e: any) => e.message).join("; ") };
    }
    return { ok: true, status: res.status, json, text };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message ?? e) };
  }
}

const pick = (o: any, path: string[]): any =>
  path.reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), o);

// --------- Funzioni di dominio sicure ---------

function normalizeRef(refRaw: string) {
  const ref = (refRaw || "").trim();
  const hasHash = ref.startsWith("#");
  const name = ref.replace(/^#/, "");
  const numericId = /^\d+$/.test(ref) ? ref : undefined;
  const nameWithHash = hasHash ? ref : `#${name}`;
  return { name, nameWithHash, numericId };
}

async function findOrderByRef(merchantRef: string): Promise<
  | { ok: true; order: { id: string; name: string } }
  | { ok: false; step: string; shopify_error?: any }
  | { ok: false; not_found: true }
> {
  const { name, nameWithHash, numericId } = normalizeRef(merchantRef);

  // 1) lookup diretto per ID numerico
  if (numericId) {
    const gid = `gid://shopify/Order/${numericId}`;
    const q = `query($id: ID!){ order(id:$id){ id name } }`;
    const r = await shopifyGraphQLSafe(q, { id: gid });
    if (!r.ok) return { ok: false, step: "order-by-id", shopify_error: r.json ?? r.text ?? r.error };
    const node = pick(r.json, ["data", "order"]);
    if (node?.id) return { ok: true, order: node };
  }

  // helper search
  const qSearch = `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id name } } } }`;
  async function searchBy(term: string, label: string) {
