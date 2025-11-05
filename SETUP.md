# SpedirePro + Shopify Integration Setup Guide

This guide will help you configure the SpedirePro integration for automatic label creation and tracking updates.

## Overview

**Flow:**
1. You add `SPRO-CREATE` tag to a Shopify order
2. Shopify webhook → `/api/webhooks/orders-updated` → Creates label via SpedirePro API
3. SpedirePro webhook → `/api/webhooks/spedirepro` → Updates Shopify order with tracking & label URL + **Auto-fulfills order**

---

## 1. Required Environment Variables

### SpedirePro API Configuration

```bash
# SpedirePro API Key (REQUIRED)
SPRO_API_KEY=your_spedirepro_api_key_here

# SpedirePro API Base URL (optional, defaults to production)
SPRO_API_BASE=https://www.spedirepro.com/public-api/v1

# Optional: Specify default carrier (otherwise uses auto-selection)
DEFAULT_CARRIER_NAME=UPS
```

### Sender Information (REQUIRED - Your warehouse/business address)

```bash
SENDER_NAME=Your Business Name
SENDER_EMAIL=warehouse@yourbusiness.com
SENDER_PHONE=+1234567890
SENDER_COUNTRY=US
SENDER_PROVINCE=CA
SENDER_CITY=Los Angeles
SENDER_POSTCODE=90001
SENDER_STREET=123 Warehouse St
```

### Package Defaults

```bash
# Method 1: Specify dimensions as WxHxD in cm
DEFAULT_DIM_CM=12x3x18

# Method 2: Specify each dimension separately
DEFAULT_PARCEL_W_CM=12
DEFAULT_PARCEL_H_CM=3
DEFAULT_PARCEL_D_CM=18

# Default weight in kilograms
DEFAULT_WEIGHT_KG=0.05
```

### Shopify Configuration (REQUIRED)

```bash
# Shopify store name (without .myshopify.com)
SHOPIFY_STORE=holy-trove

# Shopify Admin API Access Token (needs read_orders, write_orders, write_fulfillments permissions)
SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxx

# Shopify API version (optional, defaults to 2025-10)
SHOPIFY_API_VERSION=2025-10
```

### SpedirePro Webhook Security

```bash
# Generate a random token for webhook security
SPRO_WEBHOOK_TOKEN=your_random_secret_token_here
```

**Generate a secure token:**
```bash
openssl rand -hex 32
```

### Customs Declarations (for Extra-EU Shipments)

```bash
# Google Drive Configuration
GOOGLE_DRIVE_FOLDER_ID=your_google_drive_folder_id
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project-id.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Email Alerts Configuration (using Resend)
RESEND_API_KEY=re_your_resend_api_key
ALERT_EMAIL=your-email@example.com
```

**How customs declarations work:**
1. When a shipment is created and tracking is received
2. The system automatically checks if destination is outside EU
3. If yes, generates a customs declaration PDF with:
   - Commercial invoice with item details, HS codes, values in USD
   - Italian legal declaration (Dichiarazione di libera esportazione)
4. Uploads PDF to SpedirePro and Google Drive
5. Updates Shopify order metafield `custom.doganale` with Google Drive URL
6. Sends email alert if there are errors or missing data

**Required Shopify Metafields:**
- **Variant metafield**: `global.harmonized_system_code` - HS code (e.g., "71179090")
- **Product metafield**: `custom.cost` - Product cost in USD (metafield type: money)
- **Product metafield**: `custom.customs_description` - Customs description (e.g., "Wooden Rosary")

**Google Drive Setup:**
1. Create a Google Cloud project
2. Enable Google Drive API
3. Create a Service Account and download JSON credentials
4. Share your Google Drive folder with the service account email (as Editor)
5. Extract `GOOGLE_DRIVE_FOLDER_ID` from the folder URL
6. Set the environment variables above

**Resend Email Setup:**
1. Sign up at https://resend.com (free tier: 3000 emails/month)
2. Verify your domain (or use onboarding@resend.dev for testing)
3. Create an API key and set `RESEND_API_KEY`

---

## 2. Configure Vercel Environment Variables

1. Go to **Vercel Dashboard** → Your Project → **Settings** → **Environment Variables**
2. Add all the variables above
3. Set them for **Production, Preview, and Development**
4. Click **Save**
5. **Redeploy** your project to apply the changes

---

## 3. Set Up Shopify Webhook

### Step 1: Create Shopify Webhook

1. Go to **Shopify Admin** → **Settings** → **Notifications**
2. Scroll to **Webhooks**
3. Click **Create webhook**
4. Configure:
   - **Event:** `Order updated` (recommended to capture tag changes)
   - **Format:** `JSON`
   - **URL:** `https://webhooks.catholically.com/api/webhooks/orders-updated`
   - **API Version:** Latest

**Note:** Use "Order updated" event to trigger when you add the `SPRO-CREATE` tag.

### Step 2: Test the Integration

Test with debug mode first:
```bash
curl -X POST "https://webhooks.catholically.com/api/webhooks/orders-updated?debug=1" \
  -H "Content-Type: application/json" \
  -d '{"order":{"name":"#1001"}}'
```

**Expected response:**
```json
{
  "ok": true,
  "debug": true,
  "hasApiKey": true,
  "SPRO_API_BASE": "https://www.spedirepro.com/public-api/v1",
  "triggerTag": "ship-with-spedirepro",
  "SENDER": { ... },
  "orderName": "#1001"
}
```

Check that:
- ✅ `hasApiKey: true`
- ✅ `SENDER` contains all your address fields
- ✅ No missing fields

---

## 4. Set Up SpedirePro Webhook

### Configure in SpedirePro Dashboard

1. Go to **SpedirePro Dashboard** → **Settings** → **Webhooks**
2. Create a new webhook with:
   - **URL:** `https://webhooks.catholically.com/api/webhooks/spedirepro?token=YOUR_SPRO_WEBHOOK_TOKEN`
   - **Events:** Select all tracking and label events
   - **Active:** ✅ Enabled

**Important:** Replace `YOUR_SPRO_WEBHOOK_TOKEN` with the actual token you set in environment variables!

---

## 5. Verify Metafields in Shopify

The integration stores data in Shopify order metafields under namespace `spedirepro`:

| Metafield Key | Description |
|---------------|-------------|
| `reference` | SpedirePro reference number |
| `order_ref` | SpedirePro order ID |
| `tracking` | Tracking number |
| `tracking_url` | Tracking URL for customer |
| `label_url` | Label PDF download URL |
| `courier` | Courier/carrier name |

### View metafields:

1. Go to Shopify Admin → **Settings** → **Custom data** → **Orders**
2. You should see these metafields under namespace `spedirepro`

---

## 6. Manual Label Creation with Tag

**Label creation is triggered manually by adding the `SPRO-CREATE` tag to an order.**

### How to use:

1. **In Shopify Admin**, open an order you want to ship
2. **Add the tag** `SPRO-CREATE` to the order
3. **Save the order** - this triggers the webhook
4. The system will automatically:
   - ✅ Create a shipping label via SpedirePro
   - ✅ Wait for tracking from SpedirePro
   - ✅ Store tracking & label URL in order metafields
   - ✅ Auto-fulfill the order

**Important:** Orders without the `SPRO-CREATE` tag will be skipped (no label created).

---

## 7. Testing the Complete Flow

### Test 1: Create a Label

1. Create a test order in Shopify with complete shipping address
2. **Add the tag `SPRO-CREATE`** to the order
3. Save the order
4. Check Vercel logs for the API call
5. Check SpedirePro dashboard for the label

**Without the `SPRO-CREATE` tag, no label will be created (this is by design).**

### Test 2: Webhook Response

1. Manually trigger SpedirePro webhook (or wait for real tracking update)
2. Check Shopify order metafields for tracking data
3. Verify fulfillment was created automatically with tracking number

---

## 8. Troubleshooting

### Enable Debug Mode

Test the orders webhook:
```bash
curl -X POST "https://webhooks.catholically.com/api/webhooks/orders-updated?debug=1" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Common Issues

**❌ "sender env incomplete"**
- Solution: Ensure all SENDER_* variables are set in Vercel

**❌ "missing SPRO_API_KEY"**
- Solution: Set SPRO_API_KEY in Vercel environment variables

**❌ "create-label-failed"**
- Check Vercel runtime logs for SpedirePro API error response
- Verify API key is correct
- Check sender address is valid

**❌ "unauthorized" on SpedirePro webhook**
- Ensure webhook URL includes `?token=YOUR_TOKEN`
- Verify token matches `SPRO_WEBHOOK_TOKEN` in Vercel

**❌ Metafields not appearing**
- Verify `SHOPIFY_ADMIN_TOKEN` has `write_orders` permission
- Check Vercel logs for GraphQL errors

### View Logs

**Vercel Logs:**
1. Vercel Dashboard → Your Project → **Deployments**
2. Click latest deployment → **Runtime Logs**
3. Trigger a webhook and watch logs in real-time

---

## 9. Security Checklist

- ✅ Set `SPRO_WEBHOOK_TOKEN` to a strong random token
- ✅ Use HTTPS for all webhooks (Vercel provides this automatically)
- ✅ Keep `SHOPIFY_ADMIN_TOKEN` and `SPRO_API_KEY` secret
- ✅ Only add necessary Shopify API permissions
- ✅ Monitor webhook logs for suspicious activity

---

## 10. API Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/ping` | GET | Health check |
| `/api/webhooks/orders-updated` | POST | Shopify → SpedirePro label creation |
| `/api/webhooks/spedirepro?token=XXX` | POST | SpedirePro → Shopify tracking updates |

---

## Support

If you encounter issues:

1. Check Vercel runtime logs
2. Test with `?debug=1` parameter
3. Verify all environment variables are set
4. Check SpedirePro API documentation
5. Verify Shopify webhook is active and receiving data

---

## Next Steps

Once everything is working:

1. ✅ Test with real orders
2. ✅ Monitor for 24-48 hours
3. ✅ Set up alerts for failures (optional)
4. ✅ Document any custom workflows
5. ✅ Train staff on the system
