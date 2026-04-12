export const runtime = "nodejs";

import { getResendClient } from "@/lib/email-alerts";

// ---------- env helpers ----------
const env = (k: string, def?: string) => {
  const v = process.env[k];
  return v == null || v === "" ? def : v;
};

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------- Shopify helpers ----------
function adminBase() {
  const store = env("SHOPIFY_STORE") || env("SHOPIFY_SHOP") || "holy-trove";
  const ver = env("SHOPIFY_API_VERSION") || "2025-10";
  return `https://${store}.myshopify.com/admin/api/${ver}`;
}

async function shopifyGql(query: string, variables: Record<string, unknown> = {}) {
  const token = env("SHOPIFY_ADMIN_TOKEN") || env("SHOPIFY_ACCESS_TOKEN") || "";
  const r = await fetch(`${adminBase()}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

// ---------- Constants ----------
const COMBINE_WINDOW_DAYS = 10;
const UPS_UPGRADE_SKU = "XX9966CST";
const TAGS_TO_REMOVE = ["UPS", "Easyship"]; // Remove from secondary orders

// ---------- Types ----------
interface CombineCandidate {
  id: string; // GID
  name: string; // e.g. #38229182026
  lineItemCount: number;
  createdAt: string;
  tags: string[];
  fulfillmentStatus: string;
  deliveryStatus: string | null; // CONFIRMED, IN_TRANSIT, DELIVERED, etc.
  hasLabel: boolean;
}

// ---------- Core logic ----------

/**
 * Find orders from the same customer + same address within the combine window.
 * Returns orders that are either UNFULFILLED or FULFILLED+CONFIRMED (label printed, not shipped).
 */
async function findCombinableOrders(
  email: string,
  address1: string,
  zip: string,
  countryCode: string,
  excludeOrderId: string
): Promise<CombineCandidate[]> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - COMBINE_WINDOW_DAYS);
  const sinceISO = sinceDate.toISOString();

  // Search orders by email, created in window
  const query = `
    query($filter: String!) {
      orders(first: 20, query: $filter, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            tags
            createdAt
            displayFulfillmentStatus
            shippingAddress {
              address1
              zip
              countryCode
            }
            lineItems(first: 50) {
              edges {
                node {
                  quantity
                }
              }
            }
            fulfillments {
              displayStatus
            }
          }
        }
      }
    }`;

  const filter = `email:${email} created_at:>=${sinceISO}`;
  const result = await shopifyGql(query, { filter });
  const edges = result?.data?.orders?.edges || [];

  const candidates: CombineCandidate[] = [];

  for (const { node: order } of edges) {
    // Skip the new order itself
    if (order.id === excludeOrderId) continue;

    // Match address: same address1 + zip + country
    const addr = order.shippingAddress;
    if (!addr) continue;

    const addrMatch =
      normalizeStr(addr.address1) === normalizeStr(address1) &&
      normalizeStr(addr.zip) === normalizeStr(zip) &&
      normalizeStr(addr.countryCode) === normalizeStr(countryCode);

    if (!addrMatch) continue;

    const tags: string[] = order.tags || [];
    const fulfillmentStatus: string = order.displayFulfillmentStatus || "UNFULFILLED";
    const hasLabel = tags.some((t: string) => t.startsWith("LABEL-OK-"));

    // Get delivery status from latest fulfillment
    let deliveryStatus: string | null = null;
    if (order.fulfillments?.length > 0) {
      deliveryStatus = order.fulfillments[0].displayStatus || null;
    }

    // Include if: UNFULFILLED, or FULFILLED but still CONFIRMED (not shipped yet)
    const isUnfulfilled = fulfillmentStatus === "UNFULFILLED";
    const isLabelPrintedNotShipped = fulfillmentStatus === "FULFILLED" && deliveryStatus === "CONFIRMED";

    if (!isUnfulfilled && !isLabelPrintedNotShipped) continue;

    // Count line items
    const lineItemCount = (order.lineItems?.edges || []).reduce(
      (sum: number, e: { node: { quantity: number } }) => sum + (e.node.quantity || 1),
      0
    );

    candidates.push({
      id: order.id,
      name: order.name,
      lineItemCount,
      createdAt: order.createdAt,
      tags,
      fulfillmentStatus,
      deliveryStatus,
      hasLabel,
    });
  }

  return candidates;
}

function normalizeStr(s: string | undefined | null): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Check if an order contains ONLY UPS Upgrade items (SKU XX9966CST)
 */
async function isUpsUpgradeOnly(orderGid: string): Promise<boolean> {
  const query = `
    query($id: ID!) {
      order(id: $id) {
        lineItems(first: 50) {
          edges {
            node {
              sku
            }
          }
        }
      }
    }`;
  const result = await shopifyGql(query, { id: orderGid });
  const items = result?.data?.order?.lineItems?.edges || [];
  if (items.length === 0) return false;
  return items.every((e: { node: { sku: string } }) => e.node.sku === UPS_UPGRADE_SKU);
}

/**
 * Choose the primary order (most items; oldest if tie).
 * UPS Upgrade-only orders are always secondary.
 */
async function choosePrimaryOrder(
  newOrder: CombineCandidate,
  existingOrders: CombineCandidate[]
): Promise<{ primary: CombineCandidate; secondaries: CombineCandidate[] }> {
  const allOrders = [...existingOrders, newOrder];

  // Check which orders are UPS Upgrade only
  const upgradeFlags = await Promise.all(
    allOrders.map((o) => isUpsUpgradeOnly(o.id))
  );

  // Non-upgrade orders are candidates for primary
  const nonUpgradeOrders = allOrders.filter((_, i) => !upgradeFlags[i]);
  const upgradeOrders = allOrders.filter((_, i) => upgradeFlags[i]);

  // If all orders are upgrades (unlikely), pick the first one
  const primaryPool = nonUpgradeOrders.length > 0 ? nonUpgradeOrders : allOrders;

  // Sort: most items first, then oldest first
  primaryPool.sort((a, b) => {
    if (b.lineItemCount !== a.lineItemCount) return b.lineItemCount - a.lineItemCount;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const primary = primaryPool[0];
  const secondaries = allOrders.filter((o) => o.id !== primary.id);

  return { primary, secondaries };
}

/**
 * Tag orders, set notes, set metafield, remove UPS/Easyship from secondaries
 */
async function applyCombinetags(
  primary: CombineCandidate,
  secondaries: CombineCandidate[]
) {
  const allOrders = [primary, ...secondaries];
  const allNames = allOrders.map((o) => o.name).join(" + ");
  const combineNote = `COMBINE: ${allNames}`;

  // Metafield value: comma-separated order names
  const linkedOrdersValue = allOrders.map((o) => o.name).join(",");

  for (const order of allOrders) {
    const isPrimary = order.id === primary.id;

    // Add COMBINE tag to all
    const tagsToAdd = ["COMBINE"];

    // Remove UPS/Easyship from secondary orders
    const tagsToRemove = isPrimary ? [] : TAGS_TO_REMOVE;

    // Tag operations
    if (tagsToAdd.length > 0) {
      await shopifyGql(
        `mutation($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
        }`,
        { id: order.id, tags: tagsToAdd }
      );
    }

    if (tagsToRemove.length > 0) {
      // Only remove tags that actually exist on the order
      const actualRemove = tagsToRemove.filter((t) =>
        order.tags.some((ot) => ot.toLowerCase() === t.toLowerCase())
      );
      if (actualRemove.length > 0) {
        await shopifyGql(
          `mutation($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
          }`,
          { id: order.id, tags: actualRemove }
        );
        console.log(`[Combine] Removed tags [${actualRemove}] from secondary order ${order.name}`);
      }
    }

    // Set metafield combine.linked_orders on all orders
    await shopifyGql(
      `mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key value }
          userErrors { field message }
        }
      }`,
      {
        metafields: [
          {
            ownerId: order.id,
            namespace: "combine",
            key: "linked_orders",
            type: "single_line_text_field",
            value: linkedOrdersValue,
          },
        ],
      }
    );

    // Append combine note to order notes
    await appendOrderNote(order.id, combineNote);

    console.log(
      `[Combine] ${isPrimary ? "PRIMARY" : "SECONDARY"} ${order.name}: tagged COMBINE, note="${combineNote}"`
    );
  }
}

/**
 * Append text to order notes (preserving existing notes)
 */
async function appendOrderNote(orderGid: string, text: string) {
  // First get existing note
  const result = await shopifyGql(
    `query($id: ID!) { order(id: $id) { note } }`,
    { id: orderGid }
  );
  const existingNote: string = result?.data?.order?.note || "";

  // Don't duplicate if already present
  if (existingNote.includes(text)) return;

  const newNote = existingNote ? `${existingNote}\n${text}` : text;

  // Use REST API to update note (GraphQL orderUpdate requires different permissions)
  const orderId = orderGid.replace("gid://shopify/Order/", "");
  const store = env("SHOPIFY_STORE") || env("SHOPIFY_SHOP") || "holy-trove";
  const token = env("SHOPIFY_ADMIN_TOKEN") || env("SHOPIFY_ACCESS_TOKEN") || "";
  const ver = env("SHOPIFY_API_VERSION") || "2025-10";

  await fetch(
    `https://${store}.myshopify.com/admin/api/${ver}/orders/${orderId}.json`,
    {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ order: { id: Number(orderId), note: newNote } }),
    }
  );
}

/**
 * Send exception email when a combinable order already has a label printed
 */
async function sendCombineExceptionEmail(
  newOrderName: string,
  existingOrder: CombineCandidate,
  customerEmail: string,
  address: string
) {
  const alertEmail = env("ALERT_EMAIL");
  if (!alertEmail) return;

  const resend = getResendClient();
  if (!resend) return;

  const store = env("SHOPIFY_STORE") || env("SHOPIFY_SHOP") || "holy-trove";
  const existingId = existingOrder.id.replace("gid://shopify/Order/", "");
  const newId = newOrderName.replace("#", "");

  const subject = `📦 Combine Exception: ${newOrderName} → ${existingOrder.name} (label printed, not shipped)`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #ff9800; color: white; padding: 15px; border-radius: 5px; }
          .content { background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin-top: 20px; }
          .warning-box { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
          .info { margin: 10px 0; }
          .label { font-weight: bold; }
          a { color: #2196f3; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>📦 Combine Exception</h2>
          </div>
          <div class="content">
            <div class="warning-box">
              <p><strong>New order ${newOrderName}</strong> is from the same customer and address as <strong>${existingOrder.name}</strong>, which already has a label printed but the package has NOT been picked up yet.</p>
            </div>

            <h3>Details:</h3>
            <div class="info">
              <p><span class="label">Customer:</span> ${customerEmail}</p>
              <p><span class="label">Address:</span> ${address}</p>
              <p><span class="label">Existing order:</span> <a href="https://admin.shopify.com/store/${store}/orders/${existingId}">${existingOrder.name}</a> (label printed, not shipped)</p>
              <p><span class="label">New order:</span> <a href="https://admin.shopify.com/store/${store}/orders/${newId}">${newOrderName}</a></p>
            </div>

            <h3>Action Required:</h3>
            <p>Check if you can add the new order items to the existing package before it ships.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  try {
    await resend.emails.send({
      from: "Combine Alerts <noreply@resend.catholically.com>",
      to: alertEmail,
      subject,
      html: htmlContent,
    });
    console.log(`[Combine] Exception email sent for ${newOrderName} → ${existingOrder.name}`);
  } catch (err) {
    console.error("[Combine] Failed to send exception email:", err);
  }
}

// ---------- Webhook handler ----------

export async function POST(req: Request) {
  // Verify Shopify HMAC (basic check - same as other webhooks)
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "bad json" });
  }

  const orderGid = `gid://shopify/Order/${body.id}`;
  const orderName: string = body.name || "";
  const email: string = body.email || body.contact_email || body.customer?.email || "";
  const address = body.shipping_address;

  console.log(`[Orders Created] New order ${orderName} from ${email}`);

  if (!email || !address?.address1 || !address?.zip || !address?.country_code) {
    console.log("[Orders Created] Missing email or address, skipping combine check");
    return json(200, { ok: true, skipped: "no email or address" });
  }

  // Count line items for the new order
  const newLineItemCount = (body.line_items || []).reduce(
    (sum: number, item: { quantity?: number }) => sum + (item.quantity || 1),
    0
  );

  const newOrder: CombineCandidate = {
    id: orderGid,
    name: orderName,
    lineItemCount: newLineItemCount,
    createdAt: body.created_at || new Date().toISOString(),
    tags: (body.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean),
    fulfillmentStatus: "UNFULFILLED",
    deliveryStatus: null,
    hasLabel: false,
  };

  try {
    const candidates = await findCombinableOrders(
      email,
      address.address1,
      address.zip,
      address.country_code,
      orderGid
    );

    if (candidates.length === 0) {
      console.log(`[Orders Created] No combinable orders found for ${orderName}`);
      return json(200, { ok: true, combine: false });
    }

    console.log(
      `[Orders Created] Found ${candidates.length} combinable order(s) for ${orderName}: ${candidates.map((c) => c.name).join(", ")}`
    );

    // Separate: orders with label (exception) vs without (combine)
    const withLabel = candidates.filter((c) => c.hasLabel);
    const withoutLabel = candidates.filter((c) => !c.hasLabel);

    // Case: exception - existing order has label but not shipped
    if (withLabel.length > 0) {
      const addressStr = `${address.address1}, ${address.zip} ${address.city || ""}, ${address.country_code}`;
      for (const existing of withLabel) {
        await sendCombineExceptionEmail(orderName, existing, email, addressStr);
      }
    }

    // Case: combine - unfulfilled orders without label
    if (withoutLabel.length > 0) {
      const { primary, secondaries } = await choosePrimaryOrder(newOrder, withoutLabel);
      await applyCombinetags(primary, secondaries);
      console.log(
        `[Orders Created] Combined: primary=${primary.name}, secondaries=[${secondaries.map((s) => s.name).join(", ")}]`
      );
    }

    return json(200, {
      ok: true,
      combine: true,
      exceptions: withLabel.map((o) => o.name),
      combined: withoutLabel.length > 0
        ? {
            primary: (await choosePrimaryOrder(newOrder, withoutLabel)).primary.name,
            all: [newOrder, ...withoutLabel].map((o) => o.name),
          }
        : null,
    });
  } catch (err) {
    console.error("[Orders Created] Error in combine detection:", err);
    return json(200, { ok: true, error: String(err) });
  }
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 });
}
