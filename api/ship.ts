import type { VercelRequest, VercelResponse } from "vercel";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const { orderId } = await req.json() as { orderId?: number };
  if (!orderId) return res.status(400).json({ ok: false, error: "orderId missing" });

  const admin = `https://${process.env.SHOPIFY_SHOP}/admin/api/2025-10`;
  const shopHeaders = { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN as string };

  const order = await fetch(`${admin}/orders/${orderId}.json`, { headers: shopHeaders })
    .then(r => r.json()).then(j => j.order);

  const to = order.shipping_address;
  if (!to) return res.status(400).json({ ok: false, error: "order has no shipping_address" });

  const packages = [{ width: 10, height: 3, depth: 15, weight: 0.1 }];

  const payload = {
    merchant_reference: order.name,
    sender: {
      name: "Catholically",
      country: "IT",
      city: "Roma",
      postcode: "00100",
      province: "RM",
      street: "Via Appia 1",
      email: "support@catholically.com",
      phone: "+390612345678"
    },
    receiver: {
      name: `${to.first_name} ${to.last_name}`,
      country: to.country_code,
      city: to.city,
      postcode: to.zip,
      province: to.province_code || "",
      street: [to.address1, to.address2].filter(Boolean).join(", "),
      email: order.email,
      phone: to.phone || ""
    },
    packages,
    courier_fallback: true,
    content: { description: "Religious articles", amount: Number(order.total_price) }
  };

  const resp = await fetch(`${process.env.SPRO_API_BASE}/v1/create-label`, {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.SPRO_API_KEY as string,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const out = await resp.json();
  return res.status(200).json({ ok: true, request: payload, response: out });
}
