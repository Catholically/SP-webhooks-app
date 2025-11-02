// Runtime: Edge
export const runtime = "edge";

/**
 * Scopo: su ordine creato/aggiornato, se non già inviato a SpedirePro, crea la label.
 *
 * Triggera questo endpoint dal tuo sistema (Shopify Webhook "orders/create" + "orders/updated")
 * o da Flow/Mechanic.
 *
 * ENV richieste:
 * - SPRO_API_KEY
 * - SPRO_API_BASE           default "https://www.spedirepro.com/public-api/v1"
 * - SENDER_NAME,SENDER_EMAIL,SENDER_PHONE
 * - SENDER_COUNTRY,SENDER_PROVINCE,SENDER_CITY,SENDER_POSTCODE,SENDER_STREET
 * - DEFAULT_PARCEL_WEIGHT_G (default "50")
 * - DEFAULT_PARCEL_W_CM, DEFAULT_PARCEL_H_CM, DEFAULT_PARCEL_D_CM  (default 10,2,15)
 */

const ok = (o: unknown) =>
  new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const bad = (s: number, m: string) =>
  new Response(JSON.stringify({ ok: false, error: m }), { status: s, headers: { "content-type": "application/json" } });

function env(key: string, def?: string) {
  const v = process.env[key];
  return v == null || v === "" ? def : v;
}

type ShopifyOrder = {
  id: number;
  name: string; // es. "#35583..."
  tags?: string;
  shipping_address?: {
    name?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    country_code?: string; // "US"
    province_code?: string; // "CA"
    city?: string;
    zip?: string;
    address1?: string;
  };
  total_weight?: number; // grams
  line_items?: Array<{ title: string }>;
};

export async function POST(req: Request) {
  let order: ShopifyOrder | null = null;
  try {
    const payload = await req.json();
    order = (payload?.order || payload) as ShopifyOrder;
  } catch {
    return bad(400, "bad json");
  }
  if (!order || !order.name) return ok({ ok: true, skipped: "no order" });

  // idempotenza semplice: tag "SPRO-SENT"
  if ((order.tags || "").toLowerCase().includes("spro-sent")) {
    return ok({ ok: true, skipped: "already sent" });
  }

  const to = order.shipping_address;
  if (!to?.country_code || !to?.address1 || !to?.zip || !to?.city) {
    return ok({ ok: true, skipped: "missing shipping address" });
  }

  // pacco: da peso ordine o da default
  const grams = order.total_weight || Number(env("DEFAULT_PARCEL_WEIGHT_G", "50"));
  const weightKg = Math.max(0.01, grams / 1000);
  const w = Number(env("DEFAULT_PARCEL_W_CM", "10"));
  const h = Number(env("DEFAULT_PARCEL_H_CM", "2"));
  const d = Number(env("DEFAULT_PARCEL_D_CM", "15"));

  const apiBase = env("SPRO_API_BASE", "https://www.spedirepro.com/public-api/v1");
  const token = env("SPRO_API_KEY")!;
  const body = {
    merchant_reference: order.name, // <- fondamentale per il match nel webhook
    sender: {
      name: env("SENDER_NAME")!,
      email: env("SENDER_EMAIL")!,
      phone: env("SENDER_PHONE")!,
      country: env("SENDER_COUNTRY")!,
      province: env("SENDER_PROVINCE")!,
      city: env("SENDER_CITY")!,
      postcode: env("SENDER_POSTCODE")!,
      street: env("SENDER_STREET")!,
    },
    receiver: {
      name: to.name || `${to.first_name || ""} ${to.last_name || ""}`.trim(),
      email: "", // opzionale
      phone: to.phone || "",
      country: to.country_code,
      province: to.province_code || "",
      city: to.city,
      postcode: to.zip,
      street: to.address1,
    },
    packages: [{ weight: weightKg, width: w, height: h, depth: d }],
    courier_fallback: true,
    content: {
      description: order.line_items?.[0]?.title || "Order items",
      amount: 10.0,
    },
  };

  const r = await fetch(`${apiBase}/create-label`, {
    method: "POST",
    headers: { "X-Api-Key": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const out = await r.text();
  const okHTTP = r.ok;
  return ok({ ok: okHTTP, create_label_response: out });
}
