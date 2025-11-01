// --- dopo extract(...) e i controlli, prima del return ok ---
const SHOP  = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;

async function shopifyREST(path: string, init?: RequestInit) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-10${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init?.headers || {})
    }
  });
  const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, json, text };
}

async function shopifyGQL(query: string, variables?: Record<string, any>) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch {}
  return { ok: r.ok && !j?.errors, status: r.status, json: j, text: t };
}

// 1) trova l'ordine per name (#NNN)
const q = `
  query($q:String!){
    orders(first:1, query:$q){ edges{ node{ id legacyResourceId name displayFulfillmentStatus } }
  }`;
const qr = await shopifyGQL(q, { q: `name:${ex.merchantRef}` });
const node = qr.json?.data?.orders?.edges?.[0]?.node;
if (!qr.ok || !node) {
  console.warn("spedirepro: order not found for", ex.merchantRef, qr.text?.slice?.(0,200));
  return ok({ received:true, warn:"order-not-found", merchant_reference: ex.merchantRef });
}
const orderGid = node.id;
const orderId  = Number(node.legacyResourceId);

// 2) salva metafield spro.reference e spro.label_url
const m = `
mutation($metafields:[MetafieldsSetInput!]!){
  metafieldsSet(metafields:$metafields){ userErrors{ message } }
}`;
const metas:any[] = [{ ownerId: orderGid, namespace:"spro", key:"reference", type:"single_line_text_field", value: ex.reference || "" }];
if (ex.labelUrl) metas.push({ ownerId: orderGid, namespace:"spro", key:"label_url", type:"url", value: ex.labelUrl });
await shopifyGQL(m, { metafields: metas });

// 3) fulfillment: prova a creare se ci sono Fulfillment Orders "open", altrimenti aggiorna tracking
const fos = await shopifyREST(`/orders/${orderId}/fulfillment_orders.json`, { method:"GET" });
const openFOs = (fos.json?.fulfillment_orders || []).filter((fo:any)=> fo.status === "open");

if (openFOs.length && ex.tracking) {
  // crea fulfillment V3 (line_items_by_fulfillment_order)
  const body = {
    fulfillment: {
      line_items_by_fulfillment_order: openFOs.map((fo:any)=> ({ fulfillment_order_id: fo.id })),
      tracking_info: {
        number: ex.tracking,
        url: ex.trackingUrl || undefined,
        company: "UPS"
      },
      notify_customer: false
    }
  };
  const cf = await shopifyREST(`/fulfillments.json`, { method: "POST", body: JSON.stringify(body) });
  console.log("spedirepro: fulfillment create ->", cf.status, cf.text?.slice?.(0,200));
} else if (ex.tracking) {
  // nessun FO open: aggiorna tracking del fulfillment più recente se esiste
  const fr = await shopifyREST(`/orders/${orderId}/fulfillments.json`, { method:"GET" });
  const lastF = (fr.json?.fulfillments || [])[0];
  if (lastF?.id) {
    const up = await shopifyREST(`/fulfillments/${lastF.id}.json`, {
      method: "PUT",
      body: JSON.stringify({
        fulfillment: {
          tracking_number: ex.tracking,
          tracking_url: ex.trackingUrl || undefined,
          tracking_company: "UPS"
        }
      })
    });
    console.log("spedirepro: fulfillment update ->", up.status, up.text?.slice?.(0,200));
  }
}

return ok({
  received: true,
  merchant_reference: ex.merchantRef || null,
  reference: ex.reference || null,
  tracking: ex.tracking || null,
  tracking_url: ex.trackingUrl || null,
  label_url: ex.labelUrl || null
});
