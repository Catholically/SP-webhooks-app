// api/webhooks/spedirepro.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

/*
ENV richieste (Vercel)
- SHOPIFY_SHOP
- SHOPIFY_ADMIN_TOKEN
- SPRO_WEBHOOK_TOKEN        // il token passato da SpedirePro in query ?token=...
*/

const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const WEBHOOK_TOKEN = process.env.SPRO_WEBHOOK_TOKEN || "";

function ok(data: any, status = 200) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function bad(status: number, error: string, detail?: any) {
  return new Response(JSON.stringify({ ok: false, error, ...(detail ? { detail } : {}) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function readJson(req: NextRequest) {
  try { return await req.json(); } catch { return null; }
}

async function shopifyREST(path: string, init?: RequestInit) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-10${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, json, text };
}
async function shopifyGQL(query: string, variables?: Record<string, any>) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok && !json?.errors, status: r.status, json, text };
}

/** Normalizza il payload SPRO in un unico oggetto */
function extract(body: any) {
  const mr =
    body?.merchant_reference ?? body?.merchantRef ?? body?.merchantReference ?? body?.order ?? body?.name;
  const ref =
    body?.reference ?? body?.shipment ?? body?.shipment_number ?? body?.order ?? body?.ref;
  const trk =
    body?.tracking ?? body?.tracking_number ?? body?.trackingNum ?? body?.tn;
  const trkUrl =
    body?.tracking_url ?? body?.trackingUrl ?? body?.url ?? body?.link;
  const lbl =
    body?.label?.link ??
    body?.label_url ??
    body?.labelUrl ??
    body?.label ??
    body?.link ??
    (typeof body === "string" && body.includes("spedirepro.com") ? body : undefined);

  // assicurati che merchantRef includa il cancelletto
  let merchantRef = typeof mr === "string" ? mr : undefined;
  if (merchantRef && !merchantRef.startsWith("#")) merchantRef = `#${merchantRef}`;

  return {
    merchantRef,
    reference: typeof ref === "string" ? ref : undefined,
    tracking: typeof trk === "string" ? trk : undefined,
    trackingUrl: typeof trkUrl === "string" ? trkUrl : undefined,
    labelUrl: typeof lbl === "string" ? lbl : undefined,
  };
}

/** Salva/aggiorna metafield spro.* su ordine */
async function setOrderMetafields(orderGid: string, fields: Record<string, string>) {
  const metas = Object.entries(fields)
    .filter(([, v]) => !!v)
    .map(([k, v]) => ({
      ownerId: orderGid,
      namespace: "spro",
      key: k,
      type: k === "label_url" ? "url" : "single_line_text_field",
      value: String(v),
    }));
  if (!metas.length) return { ok: true };
  const m = `mutation($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){ userErrors{ message } }
  }`;
  return await shopifyGQL(m, { metafields: metas });
}

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") return bad(405, "method-not-allowed");

  // auth semplice su query ?token=
const url = new URL(req.url);
const token = url.searchParams.get("token") || "";
  
  if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) return bad(401, "unauthorized");

  const body = await readJson(req);
  if (!body) return bad(400, "invalid-json");

  const ex = extract(body);
  console.log("spedirepro: incoming", {
    merchantRef: ex.merchantRef,
    reference: ex.reference,
    tracking: ex.tracking,
    labelUrl_present: !!ex.labelUrl,
  });

  if (!ex.merchantRef) return bad(400, "missing-merchant-reference");

  // trova ordine via GraphQL cercando per name "#NNN"
  const q = `
    query($q:String!){
      orders(first:1, query:$q){
        edges{ node{ id legacyResourceId name displayFulfillmentStatus } }
      }
    }`;
  const lookup = await shopifyGQL(q, { q: `name:${ex.merchantRef}` });
  const node = lookup.json?.data?.orders?.edges?.[0]?.node;
  if (!lookup.ok || !node) {
    console.warn("spedirepro: order-not-found", ex.merchantRef, lookup.text?.slice?.(0, 200));
    return ok({ received: true, warn: "order-not-found", merchant_reference: ex.merchantRef });
  }
  const orderGid = node.id as string;
  const orderId = Number(node.legacyResourceId);

  // salva metafield reference + label_url se presente
  await setOrderMetafields(orderGid, {
    reference: ex.reference || "",
    ...(ex.labelUrl ? { label_url: ex.labelUrl } : {}),
  });

  // fulfillment: se ci sono FO aperti crea un fulfillment con tracking; altrimenti prova update tracking
  if (ex.tracking) {
    const fos = await shopifyREST(`/orders/${orderId}/fulfillment_orders.json`, { method: "GET" });
    const openFOs = (fos.json?.fulfillment_orders || []).filter((fo: any) => fo.status === "open");

    if (openFOs.length) {
      const bodyCreate = {
        fulfillment: {
          line_items_by_fulfillment_order: openFOs.map((fo: any) => ({ fulfillment_order_id: fo.id })),
          tracking_info: {
            number: ex.tracking,
            url: ex.trackingUrl || undefined,
            company: "UPS",
          },
          notify_customer: false,
        },
      };
      const cf = await shopifyREST(`/fulfillments.json`, {
        method: "POST",
        body: JSON.stringify(bodyCreate),
      });
      console.log("spedirepro: fulfillment create ->", cf.status, cf.text?.slice?.(0, 200));
    } else {
      const fr = await shopifyREST(`/orders/${orderId}/fulfillments.json`, { method: "GET" });
      const last = (fr.json?.fulfillments || [])[0];
      if (last?.id) {
        const up = await shopifyREST(`/fulfillments/${last.id}.json`, {
          method: "PUT",
          body: JSON.stringify({
            fulfillment: {
              tracking_number: ex.tracking,
              tracking_url: ex.trackingUrl || undefined,
              tracking_company: "UPS",
            },
          }),
        });
        console.log("spedirepro: fulfillment update ->", up.status, up.text?.slice?.(0, 200));
      }
    }
  }

  return ok({
    received: true,
    merchant_reference: ex.merchantRef || null,
    reference: ex.reference || null,
    tracking: ex.tracking || null,
    tracking_url: ex.trackingUrl || null,
    label_url: ex.labelUrl || null,
  });
}
