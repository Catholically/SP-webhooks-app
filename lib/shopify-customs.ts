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
                harmonizedSystemCode: metafield(namespace: "global", key: "harmonized_system_code") {
                  value
                }
                customsCost: metafield(namespace: "custom", key: "cost") {
                  value
                }
                customsDescription: metafield(namespace: "custom", key: "customs_description") {
                  value
                }
                product {
                  id
                  title
                  productType
                  vendor
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

  // List of keywords to identify service/insurance items (not physical goods)
  const serviceKeywords = [
    'insurance',
    'protection',
    'warranty',
    'service',
    'assurance',
    'shipping protection',
    'green shipping',
    'tip', // Gratuity/tip line items
  ];

  for (const edge of order.lineItems.edges || []) {
    const node = edge.node;

    // Check for service/non-physical items FIRST (before variant check)
    // Some items like "Tip", "Insurance" don't have variants but should be excluded
    const title = (node.title || '').toLowerCase();

    const isService = serviceKeywords.some(keyword =>
      title.includes(keyword)
    );

    if (isService) {
      console.log(`[Customs] Skipping service item: ${node.title}`);
      continue; // Skip this item, don't include in customs declaration
    }

    // Now check for variant/product (for actual physical products)
    const variant = node.variant;
    const product = variant?.product;

    if (!variant || !product) {
      missingData.push(`${node.title}: No product variant found`);
      continue;
    }

    // Skip products with vendor = "Excluded"
    const vendor = (product.vendor || '').trim();
    if (vendor.toLowerCase() === 'excluded') {
      console.log(`[Customs] Skipping excluded vendor item: ${node.title}`);
      continue;
    }

    // Double-check with product info for service items
    const productTitle = (product.title || '').toLowerCase();
    const productType = (product.productType || '').toLowerCase();

    const isServiceProduct = serviceKeywords.some(keyword =>
      productTitle.includes(keyword) || productType.includes(keyword)
    );

    if (isServiceProduct) {
      console.log(`[Customs] Skipping service item: ${node.title}`);
      continue; // Skip this item, don't include in customs declaration
    }

    // Extract HS Code (from variant.global.harmonized_system_code)
    const hsCode = variant.harmonizedSystemCode?.value?.trim();
    if (!hsCode) {
      missingData.push(`${node.title}: Missing HS Code (metafield global.harmonized_system_code on variant)`);
    }

    // Extract customs cost (USD) - from variant metafield
    const costStr = variant.customsCost?.value;
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
      missingData.push(`${node.title}: Missing or invalid cost (metafield custom.cost on variant)`);
    }

    // Extract customs description - from variant metafield
    const customsDescription = variant.customsDescription?.value?.trim();
    if (!customsDescription) {
      missingData.push(`${node.title}: Missing customs description (metafield custom.customs_description on variant)`);
    }

    // Use default weight (0.1 kg = 100g per item)
    // Weight data not available via GraphQL API on variants
    const weightKg = 0.1;

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

  // If no physical goods found (only services), return empty customs data
  if (lineItems.length === 0) {
    console.log(`[Customs] No physical goods found in order ${order.name} (only services/insurance)`);
    return {
      orderName: order.name,
      orderNumber: order.name.replace('#', ''),
      lineItems: [],
      totalValue: 0,
      receiverEmail: order.email || "",
      receiverPhone: order.phone || "",
    };
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
