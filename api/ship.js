export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    // body parsing robusto
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    const { orderId } = body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: "orderId missing" });

    const admin = `https://${process.env.SHOPIFY_SHOP}/admin/api/2025-10`;
    const shopHeaders = { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN };

    // 1) Shopify → get order
    const orderResp = await fetch(`${admin}/orders/${orderId}.json`, { headers: shopHeaders });
    const orderText = await orderResp.text();
    if (!orderResp.ok) {
      return res.status(502).json({ ok: false, step: "shopify_get_order", status: orderResp.status, body: orderText });
    }
    const orderJson = JSON.parse(orderText);
    const order = orderJson.order;
    const to = order && order.shipping_address;
    if (!to) return res.status(400).json({ ok: false, error: "order has no shipping_address" });

    // 2) build payload SPRO
    const packages = [{ width: 10, height: 3, depth: 15, weight: 0.1 }];
    const payload = {
      merchant_reference: order.name,
      sender: {
        name: "Catholically", country: "IT", city: "Roma", postcode: "00100",
        province: "RM", street: "Via Appia 1", email: "support@catholically.com", phone: "+390612345678"
      },
      receiver: {
        name: `${to.first_name || ""} ${to.last_name || ""}`.trim(),
        country: to.country_code, city: to.city, postcode: to.zip,
        province: to.province_code || "", street: [to.address1, to.address2].filter(Boolean).join(", "),
        email: order.email, phone: to.phone || ""
      },
      packages, courier_fallback: true,
      content: { description: "Religious articles", amount: Number(order.total_price) }
    };

    // 3) SPRO → create label
    const sproResp = await fetch(`${process.env.SPRO_API_BASE}/create-label`, {
      method: "POST",
      headers: { "X-Api-Key": process.env.SPRO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const sproText = await sproResp.text();
    if (!sproResp.ok) {
      return res.status(502).json({ ok: false, step: "spro_create_label", status: sproResp.status, body: sproText, sent: payload });
    }
    let sproJson;
    try { sproJson = JSON.parse(sproText); } catch { sproJson = { raw: sproText }; }

    return res.status(200).json({ ok: true, created: sproJson });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}
