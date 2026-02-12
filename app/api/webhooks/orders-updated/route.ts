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
const SPRO_API_KEY_NODDP = env("SPRO_API_KEY_NODDP"); // DDU account for non-USA/EU
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
    company?: string;
    phone?: string;
    country_code?: string;
    province_code?: string;
    city?: string;
    zip?: string;
    address1?: string;
    address2?: string;
  };
  billing_address?: { phone?: string };
  customer?: {
    email?: string;
  };
};

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/**
 * Normalize phone number for SpedirePro/UPS API
 * - Removes spaces, dashes, parentheses
 * - Strips Amazon relay extensions (extra 4 digits appended to phone numbers)
 * - Keeps original format (00xx prefix preserved)
 */
function normalizePhone(phone: string | undefined | null): string {
  if (!phone) return "+15555555555"; // Default fallback

  // Remove all non-digit characters except +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Extract just digits for length check
  const digitsOnly = cleaned.replace(/\D/g, '');

  // Amazon relay phone numbers: they append a 4-digit extension to real phone numbers
  // E.g. 0016026716610 (13 digits) + 4373 (ext) = 00160267166104373 (17 digits)
  // Real phone numbers are max 13 digits (with 00 prefix) or 12 (with + prefix)
  // If more than 13 digits, strip the last 4 (Amazon extension)
  if (digitsOnly.length > 13) {
    cleaned = digitsOnly.substring(0, digitsOnly.length - 4);
    console.log(`[normalizePhone] Stripped Amazon extension: ${phone} → ${cleaned}`);
  }

  return cleaned || "+15555555555";
}

/**
 * Normalize special characters for SpedirePro API compatibility
 * German: ß → ss, ä → ae, ö → oe, ü → ue
 * French: é/è/ê → e, à → a, etc.
 */
function normalizeAddress(text: string | undefined): string {
  if (!text) return "";
  return text
    // German
    .replace(/ß/g, 'ss')
    .replace(/ä/gi, (m) => m === 'Ä' ? 'Ae' : 'ae')
    .replace(/ö/gi, (m) => m === 'Ö' ? 'Oe' : 'oe')
    .replace(/ü/gi, (m) => m === 'Ü' ? 'Ue' : 'ue')
    // French/Spanish/Portuguese accents
    .replace(/[éèêë]/gi, 'e')
    .replace(/[àâá]/gi, 'a')
    .replace(/[ùûú]/gi, 'u')
    .replace(/[îï]/gi, 'i')
    .replace(/[ôó]/gi, 'o')
    .replace(/ç/gi, 'c')
    .replace(/ñ/gi, 'n')
    // Nordic
    .replace(/[åæ]/gi, 'a')
    .replace(/ø/gi, 'o');
}

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

  console.log(`[updateOrderTags] Store: ${store}, Order: ${orderId}, Remove: [${tagsToRemove}], Add: [${tagsToAdd}]`);

  const orderGid = `gid://shopify/Order/${orderId}`;

  // Remove tags
  if (tagsToRemove.length > 0) {
    const removeQuery = `
      mutation tagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }`;
    const removeResp = await fetch(`${adminUrl}/graphql.json`, {
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
    const removeResult = await removeResp.json();
    console.log(`[updateOrderTags] Remove result:`, JSON.stringify(removeResult));
  }

  // Add tags
  if (tagsToAdd.length > 0) {
    const addQuery = `
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }`;
    const addResp = await fetch(`${adminUrl}/graphql.json`, {
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
    const addResult = await addResp.json();
    console.log(`[updateOrderTags] Add result:`, JSON.stringify(addResult));
  }
}

// Set metafield on order to trigger email sending
async function setOrderMetafield(orderId: number, namespace: string, key: string, value: string) {
  const store = env("SHOPIFY_STORE") || env("SHOPIFY_SHOP") || "holy-trove";
  const token = env("SHOPIFY_ADMIN_TOKEN") || env("SHOPIFY_ACCESS_TOKEN") || "";
  const apiVersion = env("SHOPIFY_API_VERSION") || "2025-10";
  const adminUrl = `https://${store}.myshopify.com/admin/api/${apiVersion}`;

  const orderGid = `gid://shopify/Order/${orderId}`;

  const metafieldMutation = `
    mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }`;

  await fetch(`${adminUrl}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: metafieldMutation,
      variables: {
        metafields: [{
          ownerId: orderGid,
          namespace: namespace,
          key: key,
          value: value,
          type: "single_line_text_field"
        }]
      },
    }),
  });
}

// Get metafield value from order
async function getOrderMetafield(orderGid: string, namespace: string, key: string): Promise<string | null> {
  const store = env("SHOPIFY_STORE") || env("SHOPIFY_SHOP") || "holy-trove";
  const token = env("SHOPIFY_ADMIN_TOKEN") || env("SHOPIFY_ACCESS_TOKEN") || "";
  const apiVersion = env("SHOPIFY_API_VERSION") || "2025-10";
  const adminUrl = `https://${store}.myshopify.com/admin/api/${apiVersion}`;

  const query = `
    query getMetafield($id: ID!, $namespace: String!, $key: String!) {
      order(id: $id) {
        metafield(namespace: $namespace, key: $key) {
          value
        }
      }
    }
  `;

  try {
    const resp = await fetch(`${adminUrl}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { id: orderGid, namespace, key },
      }),
    });

    const data = await resp.json();
    return data?.data?.order?.metafield?.value || null;
  } catch (error) {
    console.error(`Failed to get metafield ${namespace}.${key}:`, error);
    return null;
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

  // 📄 CHECK FOR DOG TAGS FIRST (MI-DOG, RM-DOG) - Generate customs docs only
  // This must be checked BEFORE the LABEL-OK check, because DOG tags are used
  // on orders that already have labels (and thus have LABEL-OK-* tags)
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 📧 LABEL TAG HANDLING - Send existing label via email
  // ═══════════════════════════════════════════════════════════════════════════
  const hasLabelTag = tags.includes("LABEL");
  const hasLabelSentTag = tags.includes("LABEL-SENT");

  // Skip if LABEL-SENT already exists (prevent duplicate emails)
  if (hasLabelTag && hasLabelSentTag) {
    console.log(`⚠️ [Send Label] SKIPPED: Order ${order.name} already has LABEL-SENT tag (duplicate prevention)`);
    return json(200, {
      ok: true,
      skipped: true,
      reason: "label-sent-tag-exists",
      order: order.name,
      message: "Label email already sent (LABEL-SENT tag found)"
    });
  }

  if (hasLabelTag) {
    console.log(`📧 [Send Label] Processing LABEL tag for order ${order.name}`);

    const orderIdStr = String(order.id);
    const orderGid = `gid://shopify/Order/${orderIdStr}`;

    // 1. Query label URL from metafield
    const labelUrl = await getOrderMetafield(orderGid, "spedirepro", "ldv_url") ||
                     await getOrderMetafield(orderGid, "spedirepro", "label_url");

    if (!labelUrl) {
      console.error(`❌ [Send Label] No label URL found for order ${order.name}`);
      return json(200, {
        ok: false,
        error: "no-label-url",
        message: "Cannot send label: no label URL in metafields",
        tag: "LABEL",
        order: order.name,
      });
    }

    console.log(`📧 [Send Label] Found label URL: ${labelUrl}`);

    // 2. Send email with label and shipping address
    const { sendLabelEmail } = await import('@/lib/email-label');

    const success = await sendLabelEmail(
      order.name,
      labelUrl,
      {
        name: order.shipping_address?.name,
        address1: order.shipping_address?.address1,
        address2: order.shipping_address?.address2,
        city: order.shipping_address?.city,
        zip: order.shipping_address?.zip,
        province_code: order.shipping_address?.province_code,
        country_code: order.shipping_address?.country_code,
      },
      'denti.cristina@gmail.com'
    );

    if (!success) {
      console.error(`❌ [Send Label] Failed to send email for order ${order.name}`);
      return json(200, {
        ok: false,
        error: "email-send-failed",
        message: "Failed to send label email",
        tag: "LABEL",
        order: order.name,
      });
    }

    // 3. Update tags: remove LABEL + todoroby, add LABEL-SENT + mom
    await updateOrderTags(order.id, ["LABEL", "todoroby"], ["LABEL-SENT", "mom"]);

    console.log(`✅ [Send Label] Email sent successfully for order ${order.name}`);

    return json(200, {
      ok: true,
      action: "label-email-sent",
      order: order.name,
      recipient: 'denti.cristina@gmail.com',
      labelUrl,
      tagsUpdated: {
        removed: ["LABEL", "todoroby"],
        added: ["LABEL-SENT", "mom"]
      }
    });
  }

  // 🔒 EARLY DUPLICATE CHECK: If LABEL-OK-* tag exists, skip CREATE tags
  // This catches race conditions where two webhooks fire before metafields are set
  // NOTE: This check is placed AFTER DOG and LABEL tag handling, because those
  // tags are meant to work on orders that already have labels
  const hasLabelOkTag = tags.some(t => t.startsWith("LABEL-OK-"));
  if (hasLabelOkTag) {
    // Check if there's a CREATE tag - if so, skip it (duplicate prevention)
    const hasCreateTag = tags.some(t => t.includes("-CREATE"));
    if (hasCreateTag) {
      console.log(`⚠️ SKIPPED: Order ${order.name} already has LABEL-OK tag (duplicate webhook for CREATE)`);
      return json(200, {
        ok: true,
        skipped: true,
        reason: "label-ok-tag-exists",
        order: order.name,
        message: "Label already created (LABEL-OK tag found)"
      });
    }
  }

  let senderCode: string | null = null;
  let usedTag: string | null = null;
  let skipAutoCustoms = false;
  let isDDU = false; // Track if using DDU (non-DDP) account

  for (const tag of tags) {
    // Check for -CREATE-DDU-NODOG tags (DDU account, no auto customs)
    if (tag.endsWith("-CREATE-DDU-NODOG")) {
      const code = tag.replace("-CREATE-DDU-NODOG", "");
      console.log(`Found CREATE-DDU-NODOG tag: ${tag}, extracted code: ${code}`);
      if (SENDERS[code as keyof typeof SENDERS]) {
        senderCode = code;
        usedTag = tag;
        skipAutoCustoms = true;
        isDDU = true;
        console.log(`Matched sender: ${senderCode}, DDU account, will skip auto customs`);
        break;
      } else {
        console.log(`No sender found for code: ${code}`);
      }
    }
    // Check for -CREATE-DDU tags (DDU account + auto customs)
    else if (tag.endsWith("-CREATE-DDU")) {
      const code = tag.replace("-CREATE-DDU", "");
      console.log(`Found CREATE-DDU tag: ${tag}, extracted code: ${code}`);
      if (SENDERS[code as keyof typeof SENDERS]) {
        senderCode = code;
        usedTag = tag;
        skipAutoCustoms = false;
        isDDU = true;
        console.log(`Matched sender: ${senderCode}, DDU account`);
        break;
      } else {
        console.log(`No sender found for code: ${code}`);
      }
    }
    // Check for -CREATE-NODOG tags (DDP account, no auto customs)
    else if (tag.endsWith("-CREATE-NODOG")) {
      const code = tag.replace("-CREATE-NODOG", "");
      console.log(`Found CREATE-NODOG tag: ${tag}, extracted code: ${code}`);
      if (SENDERS[code as keyof typeof SENDERS]) {
        senderCode = code;
        usedTag = tag;
        skipAutoCustoms = true;
        isDDU = false;
        console.log(`Matched sender: ${senderCode}, DDP account, will skip auto customs`);
        break;
      } else {
        console.log(`No sender found for code: ${code}`);
      }
    }
    // Check for regular -CREATE tags (DDP account + auto customs)
    else if (tag.endsWith("-CREATE")) {
      const code = tag.replace("-CREATE", "");
      console.log(`Found CREATE tag: ${tag}, extracted code: ${code}, available senders:`, Object.keys(SENDERS));
      if (SENDERS[code as keyof typeof SENDERS]) {
        senderCode = code;
        usedTag = tag;
        skipAutoCustoms = false;
        isDDU = false;
        console.log(`Matched sender: ${senderCode}, DDP account`);
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

  // 🔒 DUPLICATE PREVENTION: Check if label already exists
  // This prevents race conditions with multi-location orders
  const orderIdStr = String(order.id);
  const orderGid = `gid://shopify/Order/${orderIdStr}`;

  const store = env("SHOPIFY_STORE") || env("SHOPIFY_SHOP") || "holy-trove";
  const token = env("SHOPIFY_ADMIN_TOKEN") || env("SHOPIFY_ACCESS_TOKEN") || "";
  const apiVersion = env("SHOPIFY_API_VERSION") || "2025-10";
  const adminUrl = `https://${store}.myshopify.com/admin/api/${apiVersion}`;

  const checkMetafieldQuery = `
    query checkExistingLabel($id: ID!) {
      order(id: $id) {
        tracking: metafield(namespace: "spedirepro", key: "tracking") { value }
        reference: metafield(namespace: "spro", key: "reference") { value }
        labelCount: metafield(namespace: "spedirepro", key: "label_count") { value }
        lastLabelTime: metafield(namespace: "spedirepro", key: "last_label_time") { value }
        creationLock: metafield(namespace: "spedirepro", key: "label_creation_lock") { value }
      }
    }`;

  try {
    const checkResp = await fetch(`${adminUrl}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: checkMetafieldQuery,
        variables: { id: orderGid },
      }),
    });

    const checkData = await checkResp.json();
    const existingTracking = checkData?.data?.order?.tracking?.value;
    const existingReference = checkData?.data?.order?.reference?.value;
    const labelCount = parseInt(checkData?.data?.order?.labelCount?.value || "0", 10);
    const lastLabelTime = checkData?.data?.order?.lastLabelTime?.value;
    const creationLock = checkData?.data?.order?.creationLock?.value;

    // 🔒 ATOMIC LOCK: Check if another process is currently creating a label
    if (creationLock) {
      const lockTime = new Date(creationLock).getTime();
      const timeSinceLock = Date.now() - lockTime;
      const twoMinutes = 2 * 60 * 1000;

      if (timeSinceLock < twoMinutes) {
        console.error(`🔒 LOCKED: Order ${order.name} has active creation lock (${Math.round(timeSinceLock / 1000)}s old)`);
        console.error(`Another webhook is currently creating a label for this order. Blocking duplicate request.`);
        return json(200, {
          ok: false,
          blocked: true,
          reason: "creation-locked",
          order: order.name,
          lockAge: Math.round(timeSinceLock / 1000),
          message: `Label creation in progress by another process. Lock expires in ${Math.round((twoMinutes - timeSinceLock) / 1000)}s.`
        });
      } else {
        // Lock expired (stale from hung request) - will be cleared and recreated
        console.log(`⚠️ Stale lock detected (${Math.round(timeSinceLock / 1000)}s old), will clear and proceed`);
      }
    }

    // 🚨 RATE LIMIT: Block if 1 or more labels created in last 2 minutes (stricter than before)
    if (labelCount >= 1 && lastLabelTime) {
      const timeSinceLastLabel = Date.now() - new Date(lastLabelTime).getTime();
      const twoMinutes = 2 * 60 * 1000;
      if (timeSinceLastLabel < twoMinutes) {
        console.error(`🚨 RATE LIMITED: Order ${order.name} already has ${labelCount} label(s) in last 2 min!`);
        return json(200, {
          ok: false,
          blocked: true,
          reason: "rate-limited",
          order: order.name,
          labelCount,
          message: `Rate limited: ${labelCount} label(s) created recently. Wait 2 minutes or remove RM-CREATE/MI-CREATE tag manually.`
        });
      }
    }

    if (existingTracking || existingReference) {
      console.log(`⚠️ SKIPPED: Label already exists for order ${order.name}`);
      console.log(`Existing tracking: ${existingTracking}, reference: ${existingReference}`);
      return json(200, {
        ok: true,
        skipped: true,
        reason: "label-already-exists",
        order: order.name,
        tracking: existingTracking,
        reference: existingReference,
        message: "Label already created for this order (prevents duplicates)"
      });
    }
  } catch (error) {
    console.error("Error checking for existing label:", error);
    // Continue anyway - better to risk duplicate than block legitimate request
  }

  const SENDER = SENDERS[senderCode as keyof typeof SENDERS];

  const to = order.shipping_address;
  if (!to?.country_code || !to?.address1 || !to?.zip || !to?.city) {
    return json(200, { ok: true, skipped: "missing shipping address fields" });
  }

  // 🚨 COUNTRY/ACCOUNT VALIDATION: Ensure correct tag is used for destination
  const isUSAorEU = canAutoProcessLabel(to.country_code);

  // Block DDP tags for non-USA/EU countries
  if (!isDDU && !isUSAorEU) {
    console.warn(`⚠️ BLOCKED: Cannot use DDP tag ${usedTag} for country ${to.country_code}`);
    console.warn(`DDP tags (${usedTag}) can only be used for USA or EU countries`);
    console.warn(`For ${to.country_code}, use DDU tag: ${senderCode}-CREATE-DDU`);

    await sendUnsupportedCountryAlert(
      order.name,
      order.name.replace('#', ''),
      to.country_code,
      to.country_code,
      undefined,
      undefined
    );

    return json(200, {
      ok: false,
      blocked: true,
      reason: "wrong-account-ddp-for-non-usa-eu",
      message: `Cannot use DDP tag ${usedTag} for ${to.country_code}. Use ${senderCode}-CREATE-DDU instead.`,
      country: to.country_code,
      tag: usedTag,
      suggestedTag: `${senderCode}-CREATE-DDU`
    });
  }

  // Block DDU tags for USA/EU countries
  if (isDDU && isUSAorEU) {
    console.warn(`⚠️ BLOCKED: Cannot use DDU tag ${usedTag} for country ${to.country_code}`);
    console.warn(`DDU tags (${usedTag}) should NOT be used for USA or EU countries`);
    console.warn(`For ${to.country_code}, use DDP tag: ${senderCode}-CREATE`);

    await sendUnsupportedCountryAlert(
      order.name,
      order.name.replace('#', ''),
      to.country_code,
      to.country_code,
      undefined,
      undefined
    );

    return json(200, {
      ok: false,
      blocked: true,
      reason: "wrong-account-ddu-for-usa-eu",
      message: `Cannot use DDU tag ${usedTag} for ${to.country_code}. Use ${senderCode}-CREATE instead.`,
      country: to.country_code,
      tag: usedTag,
      suggestedTag: `${senderCode}-CREATE`
    });
  }

  console.log(`✅ Country ${to.country_code} validated for ${isDDU ? 'DDU' : 'DDP'} account`);

  const receiverPhone = normalizePhone(
    first(to.phone, order.billing_address?.phone, "+15555555555")
  );

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

  // Build receiver name and attention fields
  // name = person's name (always), attention = company (C/O field if present)
  const personName = (first(to.name, `${to.first_name || ""} ${to.last_name || ""}`.trim()) || "Customer")
    .substring(0, 27);

  // Concatenate address1 and address2 (for apt/suite numbers)
  // Normalize special characters for SpedirePro API compatibility
  const fullStreet = normalizeAddress([to.address1, to.address2].filter(Boolean).join(", "));
  const normalizedCity = normalizeAddress(to.city);

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
      name: normalizeAddress(personName),
      email: receiverEmail,
      phone: receiverPhone,
      country: to.country_code,
      province: receiverProvince,
      city: normalizedCity,
      postcode: to.zip,
      street: fullStreet,
    },
  };

  // Add packages and content
  sproBody.packages = [{ weight: weightKg, width: DEF_W, height: DEF_H, depth: DEF_D }];
  sproBody.content = {
    description: order.line_items?.[0]?.title || "Order items",
    amount: 10.0,
  };

  // Add attention_name field for C/O if company is present
  // This is the correct field per SpedirePro API documentation
  sproBody.receiver.attention_name = to.company ? to.company.substring(0, 27) : "";

  if (DEFAULT_CARRIER_NAME) sproBody.courier = DEFAULT_CARRIER_NAME;
  else sproBody.courier_fallback = true;

  // Log the complete request body to debug C/O field issue
  console.log('[DEBUG] SpedirePro request body:', JSON.stringify(sproBody, null, 2));

  // Select correct API key based on account type
  const activeApiKey = isDDU ? SPRO_API_KEY_NODDP : SPRO_API_KEY;
  const accountType = isDDU ? "DDU (NODDP)" : "DDP";

  if (!activeApiKey) {
    return json(500, {
      ok: false,
      error: `missing ${isDDU ? 'SPRO_API_KEY_NODDP' : 'SPRO_API_KEY/SPRO_API_TOKEN'}`,
      accountType: accountType
    });
  }

  console.log(`Creating label on ${accountType} account for ${to.country_code}`);
  console.log(`🔍 [DEBUG] Order: ${order.name}, Country: ${to.country_code}, isDDU: ${isDDU}, Account: ${accountType}`);
  console.log(`🔍 [DEBUG] Receiver: ${to.city}, ${to.zip}, Province: ${receiverProvince}, Phone: ${receiverPhone}`);

  // 🔒 SET ATOMIC LOCK: Must be set BEFORE calling SpedirePro API to prevent race conditions
  const lockTimestamp = new Date().toISOString();
  try {
    console.log(`🔒 Setting creation lock for order ${order.name} at ${lockTimestamp}`);
    await setOrderMetafield(order.id, "spedirepro", "label_creation_lock", lockTimestamp);
    console.log(`✅ Lock set successfully`);
  } catch (error) {
    console.error("⚠️ Failed to set creation lock (proceeding anyway):", error);
    // Continue anyway - better to risk duplicate than block legitimate request
  }

  const r = await fetch(`${SPRO_API_BASE}/create-label`, {
    method: "POST",
    headers: {
      "X-Api-Key": activeApiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(sproBody),
  });

  const text = await r.text();
  if (!r.ok) {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

    // Enhanced error logging
    console.error(`❌ [SPEDIREPRO API ERROR] Order: ${order.name}`);
    console.error(`   Status: ${r.status}`);
    console.error(`   Account: ${accountType}`);
    console.error(`   Country: ${to.country_code}`);
    console.error(`   Response:`, JSON.stringify(parsed, null, 2));
    console.error(`   Request body:`, JSON.stringify(sproBody, null, 2));

    // Send email alert for SpedirePro API failures
    try {
      const { sendApiErrorAlert } = await import('@/lib/email-alerts');
      await sendApiErrorAlert(
        order.name,
        order.name.replace('#', ''),
        to.country_code,
        accountType,
        r.status,
        parsed,
        sproBody
      );
      console.log(`📧 Error alert email sent for order ${order.name}`);
    } catch (emailError) {
      console.error(`Failed to send error alert email:`, emailError);
    }

    // 🔓 CLEAR LOCK on API failure
    try {
      console.log(`🔓 Clearing creation lock due to API error`);
      await setOrderMetafield(order.id, "spedirepro", "label_creation_lock", "");
    } catch (error) {
      console.error("Failed to clear lock:", error);
    }

    return json(200, { ok: false, status: r.status, reason: "create-label-failed", spro_response: parsed });
  }

  // Label created successfully - update tags (remove MI-CREATE/RM-CREATE, add LABEL-OK-MI or LABEL-OK-RM)
  const labelTag = `LABEL-OK-${senderCode}`;

  // Add warehouse-specific tags
  const tagsToAdd = [labelTag];
  if (senderCode === "MI") {
    tagsToAdd.push("UPS", "mom");
  } else if (senderCode === "RM") {
    tagsToAdd.push("todoroby", "UPS");
  }

  console.log(`✅ Label created! Now updating tags: remove [${usedTag}], add [${tagsToAdd.join(", ")}]`);
  try {
    await updateOrderTags(order.id, [usedTag], tagsToAdd);
    console.log(`✅ Tags updated successfully for order ${order.name}`);
  } catch (error) {
    console.error("❌ Failed to update order tags:", error);
    // Don't fail the whole request if tag update fails
  }

  // 🔓 CLEAR LOCK after successful label creation
  try {
    console.log(`🔓 Clearing creation lock after successful label creation`);
    await setOrderMetafield(order.id, "spedirepro", "label_creation_lock", "");
    console.log(`✅ Lock cleared successfully`);
  } catch (error) {
    console.error("Failed to clear lock:", error);
    // Don't fail the whole request if lock clear fails
  }

  // Save account type (DDU or DDP) in metafield for webhook to use correct API key
  try {
    const accountTypeValue = isDDU ? "DDU" : "DDP";
    console.log(`Setting account_type metafield to ${accountTypeValue} for order ${order.name}`);
    await setOrderMetafield(order.id, "spedirepro", "account_type", accountTypeValue);
    console.log(`✅ Account type metafield set successfully`);
  } catch (error) {
    console.error("Failed to set account_type metafield:", error);
    // Don't fail the whole request if metafield set fails
  }

  // 🚨 RATE LIMIT TRACKING: Increment label counter and timestamp
  try {
    // Get current count and increment
    const currentCount = await getOrderMetafield(orderGid, "spedirepro", "label_count");
    const newCount = (parseInt(currentCount || "0", 10) + 1).toString();
    await setOrderMetafield(order.id, "spedirepro", "label_count", newCount);
    await setOrderMetafield(order.id, "spedirepro", "last_label_time", new Date().toISOString());
    console.log(`📊 Label count updated: ${newCount} for order ${order.name}`);
  } catch (error) {
    console.error("Failed to update label count:", error);
  }

  // For MI orders, set metafield to trigger email sending
  if (senderCode === "MI") {
    try {
      console.log(`Setting email recipient metafield for MI order ${order.name}`);
      await setOrderMetafield(order.id, "spedirepro", "label_email_recipient", "denti.cristina@gmail.com");
      console.log(`✅ Email recipient metafield set successfully`);
    } catch (error) {
      console.error("Failed to set email recipient metafield:", error);
      // Don't fail the whole request if metafield set fails
    }
  }

  // If NODOG tag was used, set metafield to skip automatic customs generation
  if (skipAutoCustoms) {
    try {
      console.log(`Setting skip_customs_auto metafield for order ${order.name} (NODOG tag used)`);
      await setOrderMetafield(order.id, "spedirepro", "skip_customs_auto", "true");
      console.log(`✅ Skip customs metafield set - doganale will NOT be generated automatically`);
    } catch (error) {
      console.error("Failed to set skip_customs_auto metafield:", error);
      // Don't fail the whole request if metafield set fails
    }
  }

  return json(200, { ok: true, create_label_response: text });
}

export async function GET() {
  return new Response('Method Not Allowed', { status: 405 });
}
