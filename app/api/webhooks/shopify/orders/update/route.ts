// Shopify Order Update Webhook
// Handles order updates, specifically for manual customs generation via tags
export const runtime = "nodejs";

import { handleCustomsDeclaration } from '@/lib/customs-handler';
import { canAutoProcessLabel } from '@/lib/eu-countries';
import { sendWrongLabelTagAlert } from '@/lib/email-alerts';
import crypto from 'crypto';

/**
 * Verify Shopify webhook signature
 */
function verifyShopifyWebhook(body: string, hmacHeader: string): boolean {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Shopify Webhook] SHOPIFY_WEBHOOK_SECRET not configured');
    return false;
  }

  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');

  return hash === hmacHeader;
}

export async function POST(req: Request) {
  try {
    // Get raw body for signature verification
    const rawBody = await req.text();

    // Verify webhook signature
    const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
    if (!hmacHeader) {
      console.error('[Shopify Webhook] Missing HMAC header');
      return new Response('Unauthorized', { status: 401 });
    }

    if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
      console.error('[Shopify Webhook] Invalid HMAC signature');
      return new Response('Unauthorized', { status: 401 });
    }

    // Parse body
    const order = JSON.parse(rawBody);
    console.log('[Shopify Webhook] Order update received:', order.name);
    console.log('[Shopify Webhook] Tags:', order.tags);

    // Check tags
    const tags = order.tags ? order.tags.toLowerCase().split(', ') : [];
    const hasCustomsTag = tags.includes('rm-dog') || tags.includes('mi-dog');
    const hasLabelTag = tags.includes('rm-create') || tags.includes('mi-create');
    const wrongTag = tags.find(t => t === 'rm-create' || t === 'mi-create');

    // Get country from shipping address
    const countryCode = order.shipping_address?.country_code || '';
    const countryName = order.shipping_address?.country || countryCode;

    // CHECK: If label creation tag (MI-CREATE/RM-CREATE) on non-USA/EU order
    if (hasLabelTag && !canAutoProcessLabel(countryCode)) {
      console.error(`[Shopify Webhook] 🚨 Wrong tag used! ${wrongTag} on ${countryCode} order`);
      console.log('[Shopify Webhook] Sending alert email - NO ACTION TAKEN');

      await sendWrongLabelTagAlert(
        order.name,
        String(order.order_number),
        countryCode,
        countryName,
        wrongTag!.toUpperCase()
      );

      return new Response(
        JSON.stringify({
          ok: false,
          error: `Cannot use ${wrongTag} tag for ${countryName}. This country is not USA/EU. Use RM-DOG or MI-DOG instead.`,
          alert_sent: true
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check if order has RM-DOG or MI-DOG tag for customs generation
    if (!hasCustomsTag) {
      console.log('[Shopify Webhook] No customs tag (RM-DOG/MI-DOG) found, skipping');
      return new Response(JSON.stringify({ ok: true, skipped: 'no customs tag' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log('[Shopify Webhook] ✅ Customs tag found! Generating customs declaration...');

    // Get tracking number from metafields or fulfillments
    let tracking = null;

    // Try to get from fulfillments first
    if (order.fulfillments && order.fulfillments.length > 0) {
      const fulfillment = order.fulfillments[0];
      if (fulfillment.tracking_number) {
        tracking = fulfillment.tracking_number;
        console.log('[Shopify Webhook] Found tracking from fulfillment:', tracking);
      }
    }

    // If no tracking in fulfillments, try metafields
    if (!tracking && order.note_attributes) {
      const trackingAttr = order.note_attributes.find(
        (attr: any) => attr.name === 'tracking' || attr.name === 'tracking_number'
      );
      if (trackingAttr) {
        tracking = trackingAttr.value;
        console.log('[Shopify Webhook] Found tracking from note attributes:', tracking);
      }
    }

    if (!tracking) {
      console.error('[Shopify Webhook] ❌ No tracking number found on order');
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'No tracking number found. Please add tracking to the order first.'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Generate customs declaration
    // Use a dummy reference since this is manual
    const reference = `MANUAL-${order.order_number}`;

    await handleCustomsDeclaration(
      String(order.id),
      order.name,
      tracking,
      reference
    );

    console.log('[Shopify Webhook] ✅ Manual customs declaration completed');

    return new Response(
      JSON.stringify({
        ok: true,
        order: order.name,
        tracking: tracking,
        message: 'Customs declaration generated successfully'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[Shopify Webhook] Error processing order update:', error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export async function GET() {
  return new Response('Shopify Order Update Webhook - Use POST', { status: 405 });
}
