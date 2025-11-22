export const runtime = "nodejs";

import { canAutoProcessLabel } from '@/lib/eu-countries';
import { sendUnsupportedCountryAlert } from '@/lib/email-alerts';

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

// Multiple senders configuration (hardcoded)
const SENDERS = {
  MI: {
    name: "Roberta Parma",
    email: "robykz@gmail.com",
    phone: "+393935148686",
    country: "IT",
    province: "MI",
    city: "Inzago",
    postcode: "20065",
    street: "Via degli Oleandri 3",
  },
  RM: {
    name: "Roberta Parma",
    email: "robykz@gmail.com",
    phone: "+393935148686",
    country: "IT",
    province: "RM",
    city: "Fiumicino",
    postcode: "00054",
    street: "Viale Donato Bramante 67",
  },
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

// Mappa CAP -> Provincia per Italia
function getItalianProvinceFromCAP(cap: string): string | null {
  if (!cap) return null;

  const prefix = cap.substring(0, 2);
  const capNum = parseInt(prefix, 10);

  // Mappa range CAP -> Provincia (principali città/regioni)
  const capMap: { [key: string]: string } = {
    // Lazio
    "00": "RM", "01": "VT", "02": "RI", "03": "FR", "04": "LT",
    // Piemonte
    "10": "TO", "12": "CN", "13": "VC", "14": "AT", "15": "AL", "28": "NO",
    // Liguria
    "16": "GE", "17": "SV", "18": "IM", "19": "SP",
    // Lombardia
    "20": "MI", "21": "VA", "22": "CO", "23": "LC", "24": "BG", "25": "BS", "26": "CR", "27": "PV",
    // Veneto
    "30": "VE", "31": "TV", "32": "BL", "33": "UD", "34": "TS", "35": "PD", "36": "VI", "37": "VR", "38": "TN", "39": "BZ",
    // Emilia-Romagna
    "40": "BO", "41": "MO", "42": "RE", "43": "PR", "44": "FE", "45": "RO", "47": "RN", "48": "RA",
    // Toscana
    "50": "FI", "51": "PT", "52": "AR", "53": "SI", "54": "MS", "55": "LU", "56": "PI", "57": "LI", "58": "GR",
    // Marche
    "60": "AN", "61": "PU", "62": "MC", "63": "AP",
    // Umbria
    "05": "PG", "06": "TR",
    // Abruzzo
    "64": "TE", "65": "PE", "66": "CH", "67": "AQ",
    // Molise
    "86": "CB",
    // Campania
    "80": "NA", "81": "CE", "82": "BN", "83": "AV", "84": "SA",
    // Puglia
    "70": "BA", "71": "FG", "72": "BR", "73": "LE", "74": "TA", "76": "BT",
    // Basilicata
    "75": "MT", "85": "PZ",
    // Calabria
    "87": "CS", "88": "CZ", "89": "RC",
    // Sicilia
    "90": "PA", "91": "TP", "92": "AG", "93": "CL", "94": "RG", "95": "CT", "96": "SR", "97": "EN", "98": "ME",
    // Sardegna
    "07": "SS", "08": "NU", "09": "CA",
  };

  return capMap[prefix] || null;
}

// Shopify API helper
async function updateOrderTags(orderId: number, tagsToRemove: string[], tagsToAdd: string[]) {
  const store = env("SHOPIFY_STORE") || env("SHOPIFY_SHOP") || "holy-trove";
  const token = env("SHOPIFY_ADMIN_TOKEN") || env("SHOPIFY_ACCESS_TOKEN") || "";
  const apiVersion = env("SHOPIFY_API_VERSION") || "2025-10";
  const adminUrl = `https://${store}.myshopify.com/admin/api/${apiVersion}`;

  const orderGid = `gid://shopify/Order/${orderId}`;

  // Remove tags
  if (tagsToRemove.length > 0) {
    const removeQuery = `
      mutation tagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }`;
    await fetch(`${adminUrl}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: removeQuery,
        variables: { id: orderGid, tags: tagsToRemove },
      }),
    });
  }

  // Add tags
  if (tagsToAdd.length > 0) {
    const addQuery = `
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }`;
    await fetch(`${adminUrl}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: addQuery,
        variables: { id: orderGid, tags: tagsToAdd },
      }),
    });
  }
}

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
      availableTags: Object.keys(SENDERS).map(k => `${k}-CREATE`),
      SENDERS,
      orderName: order?.name || "(none)",
    });
  }

  if (!order?.name) {
    return json(200, { ok: true, skipped: "no order name" });
  }

  // Detect CREATE tag (MI-CREATE, RM-CREATE, etc.) and extract sender code
  const tags = (order.tags || "")
    .split(",")
    .map(s => s.trim().toUpperCase());

  console.log("Orders-updated webhook - Order:", order.name, "Tags:", tags);

  // 📄 CHECK FOR DOG TAGS (MI-DOG, RM-DOG) - Generate customs docs only
  for (const tag of tags) {
    if (tag.endsWith("-DOG")) {
      const code = tag.replace("-DOG", "");
      console.log(`Found DOG tag: ${tag}, extracted code: ${code}`);

      if (!SENDERS[code as keyof typeof SENDERS]) {
        console.log(`No sender found for code: ${code}, skipping`);
        continue;
      }

      console.log(`🔧 Processing DOG tag for order ${order.name}`);

      // Check if order already has tracking (required for DOG tags)
      // We'll fetch this from Shopify metafields
      const orderIdStr = String(order.id);
      const orderGid = `gid://shopify/Order/${orderIdStr}`;

      // Import needed function at runtime
      const { handleCustomsDeclaration } = await import('@/lib/customs-handler');

      try {
        // Fetch tracking from metafields
        const store = env("SHOPIFY_STORE") || env("SHOPIFY_SHOP") || "holy-trove";
        const token = env("SHOPIFY_ADMIN_TOKEN") || env("SHOPIFY_ACCESS_TOKEN") || "";
        const apiVersion = env("SHOPIFY_API_VERSION") || "2025-10";
        const adminUrl = `https://${store}.myshopify.com/admin/api/${apiVersion}`;

        const metafieldQuery = `
          query getTracking($id: ID!) {
            order(id: $id) {
              metafield(namespace: "spedirepro", key: "tracking") {
                value
              }
              referenceMetafield: metafield(namespace: "spro", key: "reference") {
                value
              }
            }
          }`;

        const metaResp = await fetch(`${adminUrl}/graphql.json`, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: metafieldQuery,
            variables: { id: orderGid },
          }),
        });

        const metaData = await metaResp.json();
        const tracking = metaData?.data?.order?.metafield?.value;
        const reference = metaData?.data?.order?.referenceMetafield?.value;

        if (!tracking || !reference) {
          console.error(`❌ Cannot process ${tag}: Missing tracking (${tracking}) or reference (${reference})`);
          return json(200, {
            ok: false,
            error: "missing-tracking-or-reference",
            message: `Cannot generate customs docs: tracking or SpedirePro reference not found. Please ensure label was created first.`,
            tag: tag,
          });
        }

        console.log(`✅ Found tracking: ${tracking}, reference: ${reference}`);
        console.log(`Generating customs declaration for ${tag}...`);

        // Generate customs declaration
        await handleCustomsDeclaration(orderIdStr, order.name, tracking, reference);

        // Update tags: remove DOG tag, add DOG-DONE
        await updateOrderTags(order.id, [tag], [`${code}-DOG-DONE`]);

        console.log(`✅ Customs declaration generated successfully for ${order.name}`);

        return json(200, {
          ok: true,
          action: "customs-generated",
          tag: tag,
          order: order.name,
          tracking,
        });
      } catch (error) {
        console.error(`❌ Error processing ${tag}:`, error);
        return json(200, {
          ok: false,
          error: "customs-generation-failed",
          message: error instanceof Error ? error.message : String(error),
          tag: tag,
        });
      }
    }
  }

  let senderCode: string | null = null;
  let usedTag: string | null = null;

  for (const tag of tags) {
    if (tag.endsWith("-CREATE")) {
      const code = tag.replace("-CREATE", "");
      console.log(`Found CREATE tag: ${tag}, extracted code: ${code}, available senders:`, Object.keys(SENDERS));
      if (SENDERS[code as keyof typeof SENDERS]) {
        senderCode = code;
        usedTag = tag;
        console.log(`Matched sender: ${senderCode}`);
        break;
      } else {
        console.log(`No sender found for code: ${code}`);
      }
    }
  }

  if (!senderCode || !usedTag) {
    console.log("No valid CREATE tag found, skipping order");
    return json(200, {
      ok: true,
      skipped: true,
      reason: "no-valid-create-tag",
      order: order.name,
      tags: tags,
      availableTags: Object.keys(SENDERS).map(k => `${k}-CREATE`),
      message: `Add one of these tags to trigger label creation: ${Object.keys(SENDERS).map(k => `${k}-CREATE`).join(", ")}`
    });
  }

  console.log(`Processing order ${order.name} with sender ${senderCode}`);

  const SENDER = SENDERS[senderCode as keyof typeof SENDERS];

  const to = order.shipping_address;
  if (!to?.country_code || !to?.address1 || !to?.zip || !to?.city) {
    return json(200, { ok: true, skipped: "missing shipping address fields" });
  }

  // 🚨 COUNTRY CHECK: Block label creation for non-USA/EU countries
  if (!canAutoProcessLabel(to.country_code)) {
    console.warn(`⚠️ BLOCKED: Cannot create label with ${usedTag} for country ${to.country_code}`);
    console.warn(`This tag can only be used for USA or EU countries`);
    console.warn(`Please create the label manually and use ${senderCode}-DOG tag for customs docs`);

    // Send alert email immediately
    await sendUnsupportedCountryAlert(
      order.name,
      order.name.replace('#', ''),
      to.country_code,
      to.country_code, // Country name not available, use code
      undefined, // No tracking yet
      undefined  // No drive URL yet
    );

    return json(200, {
      ok: false,
      blocked: true,
      reason: "unsupported-country-for-ddp-account",
      message: `Cannot use ${usedTag} for ${to.country_code}. This tag is only for USA/EU. Please create label manually and use ${senderCode}-DOG for customs.`,
      country: to.country_code,
      tag: usedTag,
      suggestedTag: `${senderCode}-DOG`
    });
  }

  console.log(`✅ Country ${to.country_code} is supported for auto label creation (USA or EU)`);

  const receiverPhone =
    first(to.phone, order.billing_address?.phone, "+15555555555") || "+15555555555";

  const receiverEmail =
    first(order.email, order.contact_email, order.customer?.email, SENDER.email) || SENDER.email;

  // Determina la provincia: usa quella fornita o prova a inferirla dal CAP per Italia
  let receiverProvince = to.province_code || "";
  if (!receiverProvince && to.country_code === "IT" && to.zip) {
    const inferredProvince = getItalianProvinceFromCAP(to.zip);
    if (inferredProvince) {
      receiverProvince = inferredProvince;
      console.log(`Inferred province ${inferredProvince} from CAP ${to.zip}`);
    }
  }
  // Fallback finale a "XX" se ancora mancante
  if (!receiverProvince) {
    receiverProvince = "XX";
  }

  const weightKg =
    order.total_weight && order.total_weight > 0
      ? Math.max(0.01, order.total_weight / 1000)
      : DEF_WEIGHT_KG;

  // SpedirePro ha un limite di 27 caratteri per receiver.name
  const receiverName = (first(to.name, `${to.first_name || ""} ${to.last_name || ""}`.trim()) || "Customer")
    .substring(0, 27);

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
      name: receiverName,
      email: receiverEmail,
      phone: receiverPhone,
      country: to.country_code,
      province: receiverProvince,
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

  // Label created successfully - update tags (remove MI-CREATE/RM-CREATE, add LABEL-CREATED)
  try {
    await updateOrderTags(order.id, [usedTag], ["LABEL-CREATED"]);
  } catch (error) {
    console.error("Failed to update order tags:", error);
    // Don't fail the whole request if tag update fails
  }

  return json(200, { ok: true, create_label_response: text });
}

export async function GET() {
  return new Response('Method Not Allowed', { status: 405 });
}
