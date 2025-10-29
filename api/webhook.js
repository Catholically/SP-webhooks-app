import type { VercelRequest, VercelResponse } from "vercel";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  if (req.query.token !== process.env.SPRO_WEBHOOK_TOKEN) return res.status(401).send("unauthorized");

  const w = req.body as {
    merchant_reference?: string;
    tracking?: string | null;
    tracking_url?: string | null;
    label?: { url?: string; link?: string } | null;
  };

  const admin = `https://${process.env.SHOPIFY_SHOP}/admin/api/2025-10`;
  const headers = { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN as string };

  const search = await fetch(`${admin}/orders.json?name=${encodeURIComponent(w.merchant_reference || "")}`, { headers }).then(r => r.json());
  const order = search?.orders?.[0];
  if (!order) return res.status(200).json({ ok: true, note: "order not found" });

  await fetch(`${admin}/fulfillments.json`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      fulfillment: {
        order_id: order.id,
        tracking_number: w.tracking || "",
        tracking_url: w.tracking_url || "",
        notify_customer: true
      }
    })
  });

  if (w.label?.url || w.label?.link) {
    await fetch(`${admin}/orders/${order.id}.json`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ order: { id: order.id, note: `Label: ${w.label.url || w.label.link}` } })
    });
  }

  return res.status(200).json({ ok: true });
}
