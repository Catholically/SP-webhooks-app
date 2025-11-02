import type { NextApiRequest, NextApiResponse } from "next";

// -------- utils ----------
const first = (...vals: (string | undefined | null)[]) =>
  vals.find(v => v !== undefined && v !== null && String(v).trim() !== "")?.toString().trim();

const env = (k: string, def?: string) => {
  const v = process.env[k];
  return v == null || v === "" ? def : v;
};

// Env compat
const SPRO_API_KEY = first(env("SPRO_API_KEY"), env("SPRO_API_TOKEN"));
const SPRO_API_BASE = env("SPRO_API_BASE", "https://www.spedirepro.com/public-api/v1");
const SPRO_TRIGGER_TAG = env("SPRO_TRIGGER_TAG"); // optional gate

const SENDER = {
  name: env("SENDER_NAME"),
  email: env("SENDER_EMAIL"),
  phone: env("SENDER_PHONE"),
  country: env("SENDER_COUNTRY"),
  province: first(env("SENDER_PROVINCE"), env("SENDER_PROV")),
  city: env("SENDER_CITY"),
  postcode: first(env("SENDER_POSTCODE"), env("SENDER_ZIP")),
  street: first(env("SENDER_STREET"), env("SENDER_ADDR1")),
};

function parseDims() {
  const dimStr = env("DEFAULT_DIM_CM"); // e.g. "12x3x18"
  let w = Number(env("DEFAULT_PARCEL_W_CM", "12"));
  let h = Number(env("DEFAULT_PARCEL_H_CM", "3"));
  let d = Number(env("DEFAULT_PARCEL_D_CM", "18"));
  if (dimStr) {
    const m = dimStr.toLowerCase().replace(/\s/g, "").match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
    if (m) { w = Number(m[1]); h = Number(m[2]); d = Number(m[3]); }
  }
  return { w, h, d };
}
const { w: DEF_W, h: DEF_H, d: DEF_D } = parseDims();
const DEF_WEIGHT_KG = Number(first(env("DEFAULT_WEIGHT_KG"), "0.05"));
const DEFAULT_CARRIER_NAME = env("DEFAULT_CARRIER_NAME"); // optional

type ShopifyOrder = {
  id: number;
  name: string; // "#355..."
  tags?: string;
  total_weight?: number; // grams
  line_items?: Array<{ title?: string }>;
  shipping_address?: {
    name?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    country_code?: string;
    province_code?: string;
    city?: string;
    zip?: string;
    address1?: string;
  };
  billing_address?: { phone?: string };
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.query.debug !== "1") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  // Parse order payload
  let order: ShopifyOrder | null = null;
  try {
    const payload = req.body && typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    order = (payload?.order || payload) as ShopifyOrder;
  } catch {
    return res.status(400).json({ ok: false, error: "bad json" });
  }

  if (req.query.debug === "1") {
    // Return what we WOULD send to SpedirePro to verify envs
    return res.status(200).json({
      ok: true,
      debug: true,
      SENDER,
      SPRO_API_BASE,
      hasApiKey: !!SPRO_API_KEY,
      triggerTag: SPRO_TRIGGER_TAG || "(none)",
      orderName: order?.name || "(none)",
    });
  }

  if (!order?.name) {
    return res.status(200).json({ ok: true, skipped: "no order name" });
  }

  // Optional gate on tag
  if (SPRO_TRIGGER_TAG) {
    const hasTag = (order.tags || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .includes(SPRO_TRIGGER_TAG.toLowerCase());
    if (!hasTag) {
      return res.status(200).json({ ok: true, skipped: true, reason: `tag-missing-${SPRO_TRIGGER_TAG}`, order: order.name });
    }
  }

  // Validate sender envs
  const missingSender = Object.entries(SENDER)
    .filter(([_, v]) => !v)
    .map(([k]) => k);
  if (missingSender.length) {
    return res.status(500).json({ ok: false, error: "sender env incomplete", missing: missingSender });
  }

  const to = order.shipping_address;
  if (!to?.country_code || !to?.address1 || !to?.zip || !to?.city) {
    return res.status(200).json({ ok: true, skipped: "missing shipping address fields" });
  }

  const receiverPhone = first(to.phone, order.billing_address?.phone, "+0000000000");
  const weightKg = order.total_weight && order.total_weight > 0
    ? Math.max(0.01, order.total_weight / 1000)
    : DEF_WEIGHT_KG;

  const body: any = {
    merchant_reference: order.name,
    sender: {
      name: SENDER.name,
      email: SENDER.email,
      phone: SENDER.phone,
      country: SENDER.country,
      province: SENDER.province,
      city: SENDER.city,
      postcode: SENDER.postcode,
      street: SENDER.street,
    },
    receiver: {
      name: first(to.name, `${to.first_name || ""} ${to.last_name || ""}`.trim()) || "Customer",
      email: "", // optional
      phone: receiverPhone,
      country: to.country_code,
      province: to.province_code || "",
      city: to.city,
      postcode: to.zip,
      street: to.address1,
    },
    packages: [{ weight: weightKg, width: DEF_W, height: DEF_H, depth: DEF_D }],
    content: {
      description: order.line_items?.[0]?.title || "Order items",
      amount: 10.0,
    },
  };
  if (DEFAULT_CARRIER_NAME) body.courier = DEFAULT_CARRIER_NAME;
  else body.courier_fallback = true;

  if (!SPRO_API_KEY) {
    return res.status(500).json({ ok: false, error: "missing SPRO_API_KEY/SPRO_API_TOKEN" });
  }

  const r = await fetch(`${SPRO_API_BASE}/create-label`, {
    method: "POST",
    headers: {
      "X-Api-Key": SPRO_API_KEY!,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  if (!r.ok) {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    console.error("orders-updated: SpedirePro error", { status: r.status, url: `${SPRO_API_BASE}/create-label`, body: parsed });
    return res.status(200).json({ ok: false, status: r.status, reason: "create-label-failed", spro_response: parsed });
  }

  return res.status(200).json({ ok: true, create_label_response: text });
}
