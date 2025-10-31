// api/webhooks/spedirepro.ts
// Runtime: Next.js Edge (va bene anche Node; se usi Remix cambia la firma dell'handler)
// Env richieste:
// SHOPIFY_SHOP=holy-trove.myshopify.com
// SHOPIFY_ADMIN_TOKEN=shpat_....
// DEFAULT_CARRIER_NAME=UPS
// SPRO_WEBHOOK_TOKEN=spro_2e9c41c3b4a14c8b9f7d8a1fcd392b72

import type { NextRequest } from "next/server";

export const config = { runtime: "edge" };

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const CARRIER = process.env.DEFAULT_CARRIER_NAME || "UPS";
const WEBHOOK_TOKEN = process.env.SPRO_WEBHOOK_TOKEN;

type SpedireProWebhook = {
  merchant_reference?: string; // "#35541182025" o "35541182025" o ID numerico
  reference?: string;          // id spedizione SpedirePro
  tracking?: string;           // tracking number
  tracking_url?: string;       // tracking url
  label?: { link?: string };   // URL PDF etichetta
};

async function shopifyGraphQL<T>(query: string, variables?: Record<string, any>): Promise<T> {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GQL HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function normalizeRef(refRaw: string) {
  const ref = refRaw.trim();
  const hasHash = ref.startsWith("#");
  const name = ref.replace(/^#/, "");
  const numericId = /^\d+$/.test(ref) ? ref : undefined;
  const nameWithHash = hasHash ? ref : `#${name}`;
  return { name, nameWithHash, numericId };
}

async function findOrderByRef(merchantRef: string): Promise<{ id: string; name: string } | null> {
  const { name, nameWithHash, numericId } = normalizeRef(merchantRef);

  // 1) tenta ID diretto
  if (numericId) {
    const gid = `gid://shopify/Order/${numericId}`;
    try {
      type R = { data: { order: { id: string; name: string } | null } };
      const q = /* GraphQL */ `
        query($id: ID!) { order(id: $id) { id name } }
      `;
      const r = await shopifyGraphQL<R>(q, { id: gid });
      if (r.data?.order) return r.data.order;
    } catch { /* passa a search */ }
  }

  // 2) search status:any per name con hash
  async function searchBy(term: string) {
    type R = {
      data: { orders: { edges: { node: { id: string; name: string } }[] } };
    };
    const q = /* GraphQL */ `
      query($q: String!) {
        orders(first: 1, query: $q) { edges { node { id name } } }
      }
    `;
    const r = await shopifyGraphQL<R>(q, { q: `status:any name:${JSON.stringify(term)}` });
    return r.data.orders.edges[0]?.node ?? null;
  }

  const byHash = await searchBy(nameWithHash);
  if (byHash) return byHash;

  const byPlain = await searchBy(name);
  if (byPlain) return byPlain;

  return null;
}

async function getFulfillmentOrderLineItems(orderId: string) {
  type R = {
    data: {
      order: {
        id: string;
        fulfillmentOrders: {
          edges: {
            node: {
              id: string;
              lineItems: { edges: { node: { id: string; remainingQuantity: number } }[] };
            };
          }[];
        };
      } | null;
    };
  };
  const q = /* GraphQL */ `
    query($id: ID!) {
      order(id: $id) {
        id
        fulfillmentOrders(first: 10) {
          edges {
            node {
              id
              lineItems(first: 100) { edges { node { id remainingQuantity } } }
            }
          }
        }
      }
    }
  `;
  const r = await shopifyGraphQL<R>(q, { id: orderId });
  if (!r.data.order) throw new Error("order not found when fetching fulfillmentOrders");

  const items: { fulfillmentOrderId: string; lineItemId: string; qty: number }[] = [];
  for (const fo of r.data.order.fulfillmentOrders.edges.map(e => e.node)) {
    for (const li of fo.lineItems.edges) {
      if (li.node.remainingQuantity > 0) {
        items.push({ fulfillmentOrderId: fo.id, lineItemId: li.node.id, qty: li.node.remainingQuantity });
      }
    }
  }
  return items;
}

async function createFulfillment(
  items: { fulfillmentOrderId: string; lineItemId: string; qty: number }[],
  trackingNumber: string | undefined,
  trackingUrl: string | undefined,
  trackingCompany: string,
) {
  const byFO = new Map<string, { id: string; lineItems: { id: string; quantity: number }[] }>();
  for (const it of items) {
    const g = byFO.get(it.fulfillmentOrderId) || { id: it.fulfillmentOrderId, lineItems: [] };
    g.lineItems.push({ id: it.lineItemId, quantity: it.qty });
    byFO.set(it.fulfillmentOrderId, g);
  }

  type R = {
    data: {
      fulfillmentCreateV2: {
        fulfillment: { id: string } | null;
        userErrors: { message: string }[];
      };
    };
  };
  const m = /* GraphQL */ `
    mutation($input: FulfillmentCreateV2Input!) {
      fulfillmentCreateV2(input: $input) {
        fulfillment { id }
        userErrors { message }
      }
    }
  `;

  const input = {
    notifyCustomer: false,
    trackingInfo: { company: trackingCompany, number: trackingNumber ?? "", url: trackingUrl ?? "" },
    lineItemsByFulfillmentOrder: Array.from(byFO.values()).map(group => ({
      fulfillmentOrderId: group.id,
      fulfillmentOrderLineItems: group.lineItems,
    })),
  };

  const r = await shopifyGraphQL<R>(m, { input });
  const errs = r.data.fulfillmentCreateV2.userErrors;
  if (errs?.length) throw new Error("fulfillmentCreateV2 errors: " + errs.map(e => e.message).join("; "));
  return r.data.fulfillmentCreateV2.fulfillment?.id ?? null;
}

async function setOrderMetafield(orderId: string, labelUrl?: string) {
  if (!labelUrl) return;
  type R = { data: { metafieldsSet: { userErrors: { message: string }[] } } };
  const m = /* GraphQL */ `
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }
  `;
  const metafields = [{
    ownerId: orderId,
    namespace: "spro",
    key: "label_url",
    type: "single_line_text_field",
    value: labelUrl,
  }];
  const r = await shopifyGraphQL<R>(m, { metafields });
  const errs = r.data.metafieldsSet.userErrors;
  if (errs?.length) throw new Error("metafieldsSet errors: " + errs.map(e => e.message).join("; "));
}

async function swapTags(orderId: string) {
  type R = {
    data: {
      add: { userErrors: { message: string }[] };
      rem: { userErrors: { message: string }[] };
    };
  };
  const m = /* GraphQL */ `
    mutation($id: ID!) {
      add: tagsAdd(id: $id, tags: ["SPRO-SENT"]) { userErrors { message } }
      rem: tagsRemove(id: $id, tags: ["SPRO-CREATE"]) { userErrors { message } }
    }
  `;
  const r = await shopifyGraphQL<R>(m, { id: orderId });
  const errs = [...r.data.add.userErrors, ...r.data.rem.userErrors];
  if (errs.length) throw new Error("tag errors: " + errs.map(e => e.message).join("; "));
}

// --- tracking update su fulfillment già esistente ---

async function getLatestFulfillmentId(orderId: string) {
  type R = {
    data: { order: { fulfillments: { edges: { node: { id: string } }[] } | null } | null };
  };
  const q = /* GraphQL */ `
    query($id: ID!) {
      order(id: $id) {
        fulfillments(first: 10, reverse: true) { edges { node { id } } }
      }
    }
  `;
  const r = await shopifyGraphQL<R>(q, { id: orderId });
  return r.data.order?.fulfillments?.edges[0]?.node.id ?? null;
}

async function updateFulfillmentTracking(
  fulfillmentId: string,
  trackingNumber: string | undefined,
  trackingUrl: string | undefined,
  trackingCompany: string,
) {
  type R = {
    data: {
      fulfillmentTrackingInfoUpdateV2: {
        fulfillment: { id: string } | null;
        userErrors: { message: string }[];
      };
    };
  };
  const m = /* GraphQL */ `
    mutation($id: ID!, $info: FulfillmentTrackingInput!, $notify: Boolean!) {
      fulfillmentTrackingInfoUpdateV2(
        fulfillmentId: $id,
        trackingInfo: $info,
        notifyCustomer: $notify
      ) {
        fulfillment { id }
        userErrors { message }
      }
    }
  `;
  const vars = {
    id: fulfillmentId,
    info: { company: trackingCompany, number: trackingNumber ?? "", url: trackingUrl ?? "" },
    notify: false,
  };
  const r = await shopifyGraphQL<R>(m, vars);
  const errs = r.data.fulfillmentTrackingInfoUpdateV2.userErrors;
  if (errs?.length) throw new Error("trackingUpdate errors: " + errs.map(e => e.message).join("; "));
}

// --- handler ---

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method-not-allowed" }), { status: 405 });
  }

  // valida token querystring se configurato
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (WEBHOOK_TOKEN && token !== WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
  }

  let payload: SpedireProWebhook;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid-json" }), { status: 400 });
  }

  const { merchant_reference, tracking, tracking_url, label } = payload;
  if (!merchant_reference) {
    return new Response(JSON.stringify({ ok: false, error: "missing-merchant_reference" }), { status: 400 });
  }

  try {
    const order = await findOrderByRef(merchant_reference);
    if (!order) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "order-not-found", ref: merchant_reference }),
        { status: 200 },
      );
    }

    const items = await getFulfillmentOrderLineItems(order.id);

    if (items.length === 0) {
      // nessuna quantità residua: prova aggiornare tracking su un fulfillment esistente
      const fid = await getLatestFulfillmentId(order.id);
      if (fid) {
        await updateFulfillmentTracking(fid, tracking, tracking_url, CARRIER);
        await setOrderMetafield(order.id, label?.link);
        await swapTags(order.id);
        return new Response(
          JSON.stringify({
            ok: true,
            note: "updated-tracking-on-existing-fulfillment",
            order: order.name,
            tracking,
            tracking_url,
            label_url: label?.link ?? null,
          }),
          { status: 200 },
        );
      }
      // nessun fulfillment presente: solo metafield + tag
      await setOrderMetafield(order.id, label?.link);
      await swapTags(order.id);
      return new Response(
        JSON.stringify({
          ok: true,
          note: "no-items-to-fulfill-and-no-fulfillment",
          order: order.name,
          label_url: label?.link ?? null,
        }),
        { status: 200 },
      );
    }

    // crea fulfillment nuovo con tracking
    await createFulfillment(items, tracking, tracking_url, CARRIER);
    await setOrderMetafield(order.id, label?.link);
    await swapTags(order.id);

    return new Response(
      JSON.stringify({
        ok: true,
        order: order.name,
        tracking,
        tracking_url,
        label_url: label?.link ?? null,
      }),
      { status: 200 },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? "internal-error" }), {
      status: 500,
    });
  }
}
