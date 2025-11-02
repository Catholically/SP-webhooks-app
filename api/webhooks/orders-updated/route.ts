export const runtime = "edge";

// ---- utils env compat ----
const first = (...vals: (string | undefined | null)[]) =>
  vals.find(v => v !== undefined && v !== null && String(v).trim() !== "")?.toString().trim();

const env = (name: string, def?: string) =>
  first(process.env[name], def);

// Legge chiave API SPRO (supporta entrambi i nomi)
const SPRO_API_KEY = first(env("SPRO_API_KEY"), env("SPRO_API_TOKEN"));
// Base API SPRO
const SPRO_API_BASE = env("SPRO_API_BASE", "https://www.spedirepro.com/public-api/v1");

// Gating opzionale su tag
const SPRO_TRIGGER_TAG = env("SPRO_TRIGGER_TAG"); // se vuoto, nessun gate

// Mittente: supporto a nomi vecchi e nuovi
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

// Dimensioni/peso: supporto a DEFAULT_DIM_CM ("12x3x18") o singoli campi
function parseDims() {
  const dimStr = env("DEFAULT_DIM_CM"); // es. "12x3x18"
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
const DEF_WEIGHT_KG = Number(first(env("DEFAULT_WEIGHT_KG"), "0.05")); // se non c'è total_weight

// Courier: se definito lo usiamo, altrimenti courier_fallback=true
const DEFAULT_CARRIER_NAME = env("DEFAULT_CARRIER_NAME");

// ---- tipi minimi ordine ----
type ShopifyOrder = {
  id: number;
  name: string; // es "#35583..."
  tags?: string;
  total_weight?: number; // grams
  shipping_address?: {
    name?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    country_code?: string; // "US"
    province_code?: string; // "WA"
    city?: string;
    zip?: string;
    address1?: string;
  };
  billing_address?: {
    phone?: string;
  };
  line_items?: Array<{ title?: string }>;
};

const ok = (o: unknown) =>
  new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const bad = (s: number, m: string, extra?: any) =>
  new Response(JSON.stringify({ ok: false, error: m, ...(extra || {}) }), {
    status: s, headers: { "content-type": "application/json" },
  });

export async function POST(req: Request) {
  // parse payload (può arrivare come {order:{...}} o direttamente {...})
  let order: ShopifyOrder | null = null;
  try {
    const payload = await req.json();
    order = (payload?.order || payload) as ShopifyOrder;
  } catch {
    return bad(400, "bad json");
  }

  if (!order?.name) {
    return ok({ ok: true, skipped: "no order name" });
  }

  // opzionale: gating su tag
  if (SPRO_TRIGGER_TAG) {
    const tags = (order.tags || "").toLowerCase();
    if (!tags.split(",").map(s => s.trim()).includes(SPRO_TRIGGER_TAG.toLowerCase())) {
      return ok({ ok: true, skipped: true, reason: `tag-missing-${SPRO_TRIGGER_TAG}`, order: order.name });
    }
  }

  // verifica mittente completo
  const missingSender = Object.entries(SENDER)
    .filter(([_, v]) => !v)
    .map(([k]) => k);
  if (missingSender.length) {
    return bad(500, "sender env incomplete", { missing: missingSender });
  }

  const to = order.shipping_address;
  if (!to?.country_code || !to?.address1 || !to?.zip || !to?.city) {
    return ok({ ok: true, skipped: "missing shipping address fields" });
  }

  // phone: se manca in shipping, prova da billing, altrimenti placeholder
  const receiverPhone = first(to.phone, order.billing_address?.phone, "+0000000000");

  // peso: se c'è total_weight (g) -> kg, altrimenti default kg
  const weightKg = order.total_weight && order.total_weight > 0
    ? Math.max(0.01, order.total_weight / 1000)
    : DEF_WEIGHT_KG;

  // pacco
  const pkg = { weight: weightKg, width: DEF_W, height: DEF_H, depth: DEF_D };

  // corpo per SPRO
  const body: any = {
    merchant_reference: order.name, // importantissimo per match al ritorno
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
      email: "", // opzionale
      phone: receiverPhone,
      country: to.country_code,
      province: to.province_code || "",
      city: to.city,
      postcode: to.zip,
      street: to.address1,
    },
    packages: [pkg],
    content: {
      description: order.line_items?.[0]?.title || "Order items",
      amount: 10.0,
    },
  };

  if (DEFAULT_CARRIER_NAME) {
    body.courier = DEFAULT_CARRIER_NAME;
  } else {
    body.courier_fallback = true;
  }

  if (!SPRO_API_KEY) {
    return bad(500, "missing SPRO_API_KEY/SPRO_API_TOKEN");
  }

  // chiamata a SpedirePro
  const r = await fetch(`${SPRO_API_BASE}/create-label`, {
    method: "POST",
    headers: {
      "X-Api-Key": SPRO_API_KEY,
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
    return ok({ ok: false, status: r.status, reason: "create-label-failed", spro_response: parsed });
  }

  return ok({ ok: true, create_label_response: text });
}
