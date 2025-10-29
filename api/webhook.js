async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (req.query.token !== process.env.SPRO_WEBHOOK_TOKEN) return res.status(401).send("unauthorized");

  try {
    const w = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const adminBase = `https://${process.env.SHOPIFY_SHOP}/admin/api/2025-10`;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    // 1) trova ordine per name (#...)
    const s = await fetch(`${adminBase}/orders.json?name=${encodeURIComponent(w.merchant_reference || "")}`, {
      headers: { "X-Shopify-Access-Token": token }
    }).then(r => r.json());
    const order = s?.orders?.[0];
    if (!order) return res.status(200).json({ ok: true, note: "order not found" });

    // 2) prendi primo Fulfillment Order
    const fos = await fetch(`${adminBase}/orders/${order.id}/fulfillment_orders.json`, {
      headers: { "X-Shopify-Access-Token": token }
    }).then(r => r.json());
    const fo = fos?.fulfillment_orders?.[0];
    if (!fo) return res.status(200).json({ ok: true, note: "no fulfillment_orders" });

    // 3) crea fulfillment moderno
    const fResp = await fetch(`${adminBase}/fulfillments.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        fulfillment: {
          line_items_by_fulfillment_order: [{ fulfillment_order_id: fo.id }],
          tracking_info: { number: w.tracking || "", url: w.tracking_url || "", company: "UPS" },
          notify_customer: true
        }
      })
    });
    const fText = await fResp.text();
    if (!fResp.ok) return res.status(502).json({ ok: false, step: "create_fulfillment", status: fResp.status, body: fText });

    // 4) scrivi la label nel metafield ordine (spedirepro.ldv_url, type url)
    if (w.label && (w.label.url || w.label.link)) {
      const value = w.label.url || w.label.link;

      // tenta create
      let r = await fetch(`${adminBase}/orders/${order.id}/metafields.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ metafield: { namespace: "spedirepro", key: "ldv_url", type: "url", value } })
      });

      if (!r.ok) {
        // se esiste già, fai update
        const list = await fetch(`${adminBase}/orders/${order.id}/metafields.json?namespace=spedirepro&key=ldv_url`, {
          headers: { "X-Shopify-Access-Token": token }
        }).then(x => x.json());
        const mf = (list.metafields || [])[0];
        if (mf?.id) {
          await fetch(`${adminBase}/metafields/${mf.id}.json`, {
            method: "PUT",
            headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
            body: JSON.stringify({ metafield: { id: mf.id, value, type: "url" } })
          });
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
module.exports = handler;
