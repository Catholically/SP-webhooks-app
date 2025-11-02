export const runtime = "edge";

// ---------- utils & env compat ----------
const first = (...vals: (string | undefined | null)[]) =>
  vals.find(v => v !== undefined && v !== null && String(v).trim() !== "")?.toString().trim();

const env = (k: string, def?: string) => {
  const v = process.env[k];
  return v == null || v === "" ? def : v;
};

// SpedirePro envs (support legacy names)
const SPRO_API_KEY = first(env("SPRO_API_KEY"), env("SPRO_API_TOKEN"));
const SPRO_API_BASE = env("SPRO_API_BASE", "https://www.spedirepro.com/public-api/v1");
const SPRO_CREATE_TAG = "SPRO-CREATE"; // Required tag to trigger label creation

// Sender envs (support both old/new names)
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

// Dimensions & weight (support DEFAULT_DIM_CM "WxHxD")
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
  name: string;
  tags?: string;
  email?: string;
  contact_email?: string;
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
  customer?: {
    email?: string;
  };
};

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export async function POST(req: Request) {
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") === "1";

  // Parse body (accept {order:{...}} or {...})
  let order: ShopifyOrder | null = null;
  try {
    const payload = await req.json();
    order = (payload?.order || payload) as ShopifyOrder;
  } catch {
    return json(400, { ok: false, error: "bad json" });
  }

  if (debug) {
    return json(200, {
      ok: true,
      debug: true,
      hasApiKey: !!SPRO_API_KEY,
      SPRO_API_BASE,
      requiredTag: SPRO_CREATE_TAG,
      SENDER,
      orderName: order?.name || "(none)",
    });
  }

  if (!order?.name) {
    return json(200, { ok: true, skipped: "no order name" });
  }

  // Require SPRO-CREATE tag to trigger label creation
  const hasCreateTag = (order.tags || "")
    .split(",")
    .map(s => s.trim().toUpperCase())
    .includes(SPRO_CREATE_TAG);

  if (!hasCreateTag) {
    return json(200, {
      ok: true,
      skipped: true,
      reason: "tag-missing-SPRO-CREATE",
      order: order.name,
      message: "Add 'SPRO-CREATE' tag to order to trigger label creation"
    });
  }

  // Validate sender envs
  const missingSender = Object.entries(SENDER).filter(([_, v]) => !v).map(([k]) => k);
  if (missingSender.length) {
    return json(500, { ok: false, error: "sender env incomplete", missing: missingSender });
  }

  const to = order.shipping_address;
  if (!to?.country_code || !to?.address1 || !to?.zip || !to?.city) {
    return json(200, { ok: true, skipped: "missing shipping address fields" });
  }

  const receiverPhone =
    first(to.phone, order.billing_address?.phone, "+0000000000") || "+0000000000";

  const receiverEmail =
    first(order.email, order.contact_email, order.customer?.email, SENDER.email) || SENDER.email;

  const weightKg =
    order.total_weight && order.total_weight > 0
      ? Math.max(0.01, order.total_weight / 1000)
      : DEF_WEIGHT_KG;

  const sproBody: any = {
    merchant_reference: order.name, // critical to reconcile on webhook
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
      email: receiverEmail,
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

  if (DEFAULT_CARRIER_NAME) sproBody.courier = DEFAULT_CARRIER_NAME;
  else sproBody.courier_fallback = true;

  if (!SPRO_API_KEY) {
    return json(500, { ok: false, error: "missing SPRO_API_KEY/SPRO_API_TOKEN" });
  }

  const r = await fetch(`${SPRO_API_BASE}/create-label`, {
    method: "POST",
    headers: {
      "X-Api-Key": SPRO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(sproBody),
  });

  const text = await r.text();
  if (!r.ok) {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    console.error("orders-updated: SpedirePro error", { status: r.status, url: `${SPRO_API_BASE}/create-label`, body: parsed });
    return json(200, { ok: false, status: r.status, reason: "create-label-failed", spro_response: parsed });
  }

  return json(200, { ok: true, create_label_response: text });
}

export async function GET() {
  return new Response('Method Not Allowed', { status: 405 });
}
