export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (req.query.token !== process.env.SPRO_WEBHOOK_TOKEN) return res.status(401).send("unauthorized");

  try {
    const w = req.body || {};
    const admin = `https://${process.env.SHOPIFY_SHOP}/admin/api/2025-10`;
    const headers = { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" };

    const searchResp = await fetch(`${admin}/orders.json?name=${encodeURIComponent(w.merchant_reference || "")}`, {
      headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN }
    });
    const search = await searchResp.json();
    const order = search && search.orders && search.orders[0];
    if (!order) return res.status(200).json({ ok: true, note: "order not found" });

    await fetch(`${admin}/fulfillments.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fulfillment: {
          order_id: order.id,
          tracking_number: w.tracking || "",
          tracking_url: w.tracking_url || "",
          notify_customer: true
        }
      })
    });

    if (w.label && (w.label.url || w.label.link)) {
      await fetch(`${admin}/orders/${order.id}.json`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ order: { id: order.id, note: `Label: ${w.label.url || w.label.link}` } })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}
