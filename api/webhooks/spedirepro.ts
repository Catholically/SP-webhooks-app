// Remix/Next API route compatibile (TypeScript)
// Env richieste:
// SHOPIFY_SHOP = holy-trove.myshopify.com
// SHOPIFY_ADMIN_TOKEN = ***
// OPTIONAL: DEFAULT_CARRIER_NAME per tracking.company

import type { NextRequest } from "next/server";

export const config = {
  runtime: "edge",
};

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const CARRIER = process.env.DEFAULT_CARRIER_NAME || "UPS";

type SpedireProWebhook = {
  merchant_reference?: string; // es: "#35541182025" oppure "35541182025" oppure "gid" interno vostro
  reference?: string;          // id spedizione SpedirePro
  tracking?: string;           // tracking number
  tracking_url?: string;       // tracking url
  label?: { link?: string };   // label PDF url
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

// Normalizza: "#35541182025" -> {nameWithHash:"#35541182025", name:"35541182025"}
// "6999490036051" -> numericId
function normalizeRef(refRaw: string) {
  const ref = refRaw.trim();
  const hasHash = ref.startsWith("#");
  const name = ref.replace(/^#/, "");
  const numericId = /^\d+$/.test(ref) ? ref : undefined;
  const nameWithHash = hasHash ? ref : `#${name}`;
  return { name, nameWithHash, numericId };
}

/**
 * Ricerca estesa:
 * 1) Se numericId presente -> prova GID.
 * 2) Search per name con hash: query: "status:any name:#355..."
 * 3) Search per name senza hash.
 */
async function findOrderByRef(merchantRef: string): Promise<{ id: string; name: string } | null> {
  const { name, nameWithHash, numericId } = normalizeRef(merchantRef);

  // 1) GID da numericId
  if (numericId) {
    const gid = `gid://shopify/Order/${numericId}`;
    try {
      type R = { data: { order: { id: string; name: string } | null } };
      const q = /* GraphQL */ `
        query($id: ID!) {
          order(id: $id) { id name }
        }
      `;
      const r = await shopifyGraphQL<R>(q, { id: gid });
      if (r.data?.order) return r.data.order;
    } catch {
      // ignora e passa a search
    }
  }

  // helper search
  async function searchByName(term: string) {
    type R = {
      data: {
        orders: {
          edges: { node: { id: string; name: string } }[];
        };
      };
    };
    const q = /* GraphQL */ `
      query($q: String!) {
        orders(first: 1, query: $q) {
          edges { node { id name } }
        }
      }
    `;
    const r = await shopifyGraphQL<R>(q, { q: `status:any name:${JSON.stringify(term)}` });
    const node = r.data.orders.edges[0]?.node;
    return node ?? null;
  }

  // 2) name con hash
  const byHash = await searchByName(nameWithHash);
  if (byHash) return byHash;

  // 3) name senza hash
  const byPlain = await searchByName(name);
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
              status: string;
              lineItems: {
                edges: { node: { id: string; remainingQuantity: number } }[];
              };
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
              status
              lineItems(first: 100) {
                edges { node { id remainingQuantity } }
              }
            }
          }
        }
      }
    }
  `;
  const r = await shopifyGraphQL<R>(q, { id: orderId });
  if (!r.data.order) throw new Error("order not found when fetching fulfillmentOrders");

  const fos = r.data.order.fulfillmentOrders.edges.map(e => e.node);
  // Prendi tutte le FO non cancellate
  const items = [];
  for (const fo of fos) {
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
  // Raggruppa per fulfillmentOrderId come richiesto da fulfillmentCreateV2
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
        userErrors: { field: string[] | null; message: string }[];
      };
    };
  };
  const m = /* GraphQL */ `
    mutation($input: FulfillmentCreateV2Input!) {
      fulfillmentCreateV2(input: $input) {
        fulfillment { id }
        userErrors { field message }
      }
    }
  `;

  const input = {
    notifyCustomer: false,
    trackingInfo: {
      company: trackingCompany,
      number: trackingNumber ?? "",
      url: trackingUrl ?? "",
    },
    // fulfillmentOrderLineItems richiede array di oggetti: { fulfillmentOrderId, fulfillmentOrderLineItems: [{id, quantity}, ...] }
    lineItemsByFulfillmentOrder: Array.from(byFO.values()).map(group => ({
      fulfillmentOrderId: group.id,
      fulfillmentOrderLineItems: group.lineItems,
    })),
  };

  const r = await shopifyGraphQL<R>(m, { input });
  const errs = r.data.fulfillmentCreateV2.userErrors;
  if (errs?.length) {
    throw new Error("fulfillmentCreateV2 errors: " + errs.map(e => e.message).join("; "));
  }
  return r.data.fulfillmentCreateV2.fulfillment?.id ?? null;
}

async function setOrderMetafield(orderId: string, labelUrl?: string) {
  if (!labelUrl) return;
  type R = {
    data: {
      metafieldsSet: {
        userErrors: { field: string[] | null; message: string }[];
      };
    };
  };
  const m = /* GraphQL */ `
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const input = [
    {
      ownerId: orderId,
      namespace: "spro",
      key: "label_url",
      type: "single_line_text_field",
      value: labelUrl,
    },
  ];
  const r = await shopifyGraphQL<R>(m, { metafields: input });
  const errs = r.data.metafieldsSet.userErrors;
  if (errs?.length) throw new Error("metafieldsSet errors: " + errs.map(e => e.message).join("; "));
}

async function swapTags(orderId: string) {
  // remove SPRO-CREATE, add SPRO-SENT
  type R = {
    data: {
      tagsAdd: { userErrors: { message: string }[] };
      tagsRemove: { userErrors: { message: string }[] };
    };
  };
  const m = /* GraphQL */ `
    mutation($id: ID!) {
      add: tagsAdd(id: $id, tags: ["SPRO-SENT"]) { userErrors { message } }
      rem: tagsRemove(id: $id, tags: ["SPRO-CREATE"]) { userErrors { message } }
    }
  `;
  const r = await shopifyGraphQL<R>(m, { id: orderId });
  if (r.data.add.userErrors.length || r.data.rem.userErrors.length) {
    throw new Error(
      "tag errors: " +
        [...r.data.add.userErrors, ...r.data.rem.userErrors].map(e => e.message).join("; "),
    );
  }
}

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method-not-allowed" }), { status: 405 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  // opzionale: validazione token semplice
  // if (token !== process.env.SPRO_WEBHOOK_TOKEN) return new Response(JSON.stringify({ ok:false, error:"unauthorized"}), {status:401});

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
      // niente da fulfillare: solo aggiorna metafield e tag
      await setOrderMetafield(order.id, label?.link);
      await swapTags(order.id);
      return new Response(JSON.stringify({ ok: true, note: "no-items-to-fulfill", order: order.name }), {
        status: 200,
      });
    }

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
