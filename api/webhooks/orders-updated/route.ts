// Next.js App Router
import type { NextRequest } from "next/server";
import crypto from "crypto";

// ---- ENV ----
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP!;                         // e.g. holy-trove.myshopify.com
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;           // Admin API access token
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET!;     // Orders/updated secret

const SPRO_API_BASE = process.env.SPRO_API_BASE || "https://www.spedirepro.com/public-api/v1";
const SPRO_TOKEN = process.env.SPRO_TOKEN!;                             // Bearer token from SpedirePro

// Sender defaults. Fill these to avoid 422.
const SENDER = {
  name: process.env.SENDER_NAME!,
  email: process.env.SENDER_EMAIL!,
  phone: process.env.SENDER_PHONE!,
  country: process.env.SENDER_COUNTRY || "IT",
  city: process.env.SENDER_CITY!,
  postcode: process.env.SENDER_POSTCODE!,
  street: process.env.SENDER_STREET!,
  province: process.env.SENDER_PROVINCE!, // 2-letter
};

function verifyShopifyHmac(req: NextRequest, rawBody: Buffer) {
  const h = req.headers.get("x-shopify-hmac-sha256") || "";
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(digest));
}

async function shopifyGraphQL<T>(query: string, variables?: any): Promise<T> {
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    // Important for Vercel edge/body re-use
    cache: "no-store",
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Shopify GQL ${r.status}: ${text}`);
  }
  const json = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function kg(g: number) { return Math.max(0.01, Math.round(g) / 1000); }

// Build SpedirePro payload using Shopify order
function buildSpedireProCreateLabel(order: any) {
  const addr = order?.shippingAddress;
  if (!addr) throw new Error("Order has no shippingAddress");

  return {
    // map to SpedirePro required shape
    merchant_reference: order.name, // "#1234"
    service: "UPS",                 // adjust if needed
    cod: 0,
    parcels: [
      {
        // minimal 1 parcel
        weight: kg(order.totalWeight || 500), // kg
        length: 20,
        width: 15,
        height: 4,
        description: "Religious items",
        value: Number(order.totalPriceSet?.shopMoney?.amount || 20),
      },
    ],
    sender: SENDER,
    receiver: {
      name: `${addr.firstName || ""} ${addr.lastName || ""}`.trim() || order.customer?.displayName || "Customer",
      email: order?.email || "customer@example.com",
      phone: addr?.phone || order?.phone || "0000000000",
      country: addr.countryCodeV2,
      city: addr.city,
      postcode: addr.zip,
      street: `${addr.address1}${addr.address2 ? " " + addr.address2 : ""}`,
      province: addr.provinceCode || "",
    },
  };
}

async function createSpedireProLabel(payload: any) {
  const r = await fetch(`${SPRO_API_BASE}/create-label`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SPRO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`SpedirePro ${r.status}: ${JSON.stringify(j)}`);
  }
  return j;
}

async function setOrderMetafield(orderId: string, key: string, value: string, ns = "spedirepro") {
  const q = /* GraphQL */ `
    mutation UpsertMF($ownerId: ID!, $namespace: String!, $key: String!, $value: String!) {
      metafieldsSet(metafields: [{ ownerId: $ownerId, namespace: $namespace, key: $key, type: "single_line_text_field", value: $value }]) {
        userErrors { field message }
      }
    }`;
  await shopifyGraphQL(q, { ownerId: orderId, namespace: ns, key, value });
}

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // Read raw for HMAC verification
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifyShopifyHmac(req, raw)) {
    return new Response(JSON.stringify({ ok: false, error: "invalid hmac" }), { status: 401 });
  }

  const order = JSON.parse(raw.toString("utf8"));

  // Optional: gate by tag or note. Keep simple: only when not fulfilled.
  if (order.fulfillment_status === "fulfilled") {
    return Response.json({ ok: true, skipped: "already-fulfilled", ref: order.name });
  }

  // Fetch full order for fields we need
  const data = await shopifyGraphQL<any>(/* GraphQL */ `
    query($id: ID!) {
      order(id: $id) {
        id
        name
        email
        phone
        totalWeight
        totalPriceSet{ shopMoney{ amount } }
        shippingAddress{
          firstName lastName phone address1 address2 city provinceCode zip countryCodeV2
        }
        customer{ displayName }
      }
    }`, { id: order.admin_graphql_api_id });

  const o = data.order;

  try {
    const payload = buildSpedireProCreateLabel(o);
    const sp = await createSpedireProLabel(payload);

    // SpedirePro returns reference and possibly label link. Store.
    const labelUrl =
      sp?.label?.link ||
      sp?.label_url ||
      (sp?.reference ? `https://www.spedirepro.com/le-tue-spedizioni/dettagli/${sp.reference}/label` : "");

    await setOrderMetafield(o.id, "reference", String(sp.reference || ""));
    if (labelUrl) await setOrderMetafield(o.id, "label_url", labelUrl);

    return Response.json({ ok: true, created: true, reference: sp.reference, label_url: labelUrl });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
}
