/**
 * Shopify utilities for fetching customs-related product data
 */

function adminBase() {
  const store = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "holy-trove";
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  return `https://${store}.myshopify.com/admin/api/${ver}`;
}

async function shopifyFetch(path: string, init?: RequestInit) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";
  return fetch(`${adminBase()}${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

export interface CustomsLineItem {
  title: string;
  quantity: number;
  price: number; // Price in USD from custom.cost metafield
  hsCode: string;
  customsDescription: string;
  weight: number; // Weight in kg
  origin: string; // Always "ITALY"
}

export interface OrderCustomsData {
  orderName: string;
  orderNumber: string;
  lineItems: CustomsLineItem[];
  totalValue: number;
  receiverEmail: string;
  receiverPhone: string;
}

/**
 * Fetch customs data for an order from Shopify
 * @param orderId - Shopify order ID (numeric or GID)
 * @returns Order customs data with line items
 */
export async function fetchOrderCustomsData(orderId: string): Promise<OrderCustomsData> {
  const orderGid = orderId.startsWith('gid://')
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const query = `
    query getOrderCustomsData($id: ID!) {
      order(id: $id) {
        name
        email
        phone
        lineItems(first: 50) {
          edges {
            node {
              title
              quantity
              variant {
                weight
                weightUnit
                harmonizedSystemCode: metafield(namespace: "global", key: "harmonized_system_code") {
                  value
                }
                product {
                  id
                  title
                  customsCost: metafield(namespace: "custom", key: "cost") {
                    value
                  }
                  customsDescription: metafield(namespace: "custom", key: "customs_description") {
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({
      query,
      variables: { id: orderGid },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch order from Shopify: ${response.status} ${errorText}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  const order = result.data?.order;
  if (!order) {
    throw new Error(`Order ${orderId} not found in Shopify`);
  }

  const lineItems: CustomsLineItem[] = [];
  const missingData: string[] = [];

  for (const edge of order.lineItems.edges || []) {
    const node = edge.node;
    const variant = node.variant;
    const product = variant?.product;

    if (!variant || !product) {
      missingData.push(`${node.title}: No product variant found`);
      continue;
    }

    // Extract HS Code (from variant.global.harmonized_system_code)
    const hsCode = variant.harmonizedSystemCode?.value?.trim();
    if (!hsCode) {
      missingData.push(`${node.title}: Missing HS Code (metafield global.harmonized_system_code on variant)`);
    }

    // Extract customs cost (USD)
    const costStr = product.customsCost?.value;
    let price = 0;
    if (costStr) {
      // Metafield type "money" returns JSON like: {"amount":"2.99","currency_code":"USD"}
      try {
        const costJson = JSON.parse(costStr);
        price = parseFloat(costJson.amount || "0");
      } catch {
        // If not JSON, try parsing as plain number
        price = parseFloat(costStr) || 0;
      }
    }
    if (!price || price <= 0) {
      missingData.push(`${product.title}: Missing or invalid cost (metafield custom.cost)`);
    }

    // Extract customs description
    const customsDescription = product.customsDescription?.value?.trim();
    if (!customsDescription) {
      missingData.push(`${product.title}: Missing customs description (metafield custom.customs_description)`);
    }

    // Calculate weight in kg
    let weightKg = 0;
    if (variant.weight) {
      const weight = variant.weight;
      const unit = variant.weightUnit || "GRAMS";

      switch (unit) {
        case "KILOGRAMS":
          weightKg = weight;
          break;
        case "GRAMS":
          weightKg = weight / 1000;
          break;
        case "POUNDS":
          weightKg = weight * 0.453592;
          break;
        case "OUNCES":
          weightKg = weight * 0.0283495;
          break;
        default:
          weightKg = weight / 1000; // Default to grams
      }
    }

    lineItems.push({
      title: node.title || product.title,
      quantity: node.quantity || 1,
      price: price,
      hsCode: hsCode || "",
      customsDescription: customsDescription || node.title || product.title,
      weight: weightKg,
      origin: "ITALY",
    });
  }

  if (missingData.length > 0) {
    throw new Error(
      `Missing customs data for order ${order.name}:\n${missingData.join('\n')}`
    );
  }

  const totalValue = lineItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  return {
    orderName: order.name,
    orderNumber: order.name.replace('#', ''),
    lineItems,
    totalValue,
    receiverEmail: order.email || "",
    receiverPhone: order.phone || "",
  };
}
