import { NextRequest, NextResponse } from "next/server";

/**
 * Weather Check Webhook for Holy Water Orders
 *
 * Triggered by Shopify Flow when an order contains Holy Water.
 * Checks 8-day weather forecast for destination and adds FREEZE-RISK and METEO tags if needed.
 *
 * Endpoint: POST /api/webhooks/weather-check
 *
 * Expected payload from Shopify Flow:
 * {
 *   "order_id": "gid://shopify/Order/123456",
 *   "order_name": "#12345",
 *   "city": "New York",
 *   "province_code": "NY",
 *   "country_code": "US"
 * }
 *
 * OpenWeather API: One Call 3.0 (8-day forecast)
 * Docs: https://openweathermap.org/api/one-call-3
 *
 * Flow:
 * 1. Geocoding API: city,country -> lat,lon
 * 2. One Call 3.0: lat,lon -> 8-day forecast
 */

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "holy-trove";
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || "";

// Freezing threshold in Celsius
const FREEZE_THRESHOLD_CELSIUS = 0;

// Tags to add when freeze risk is detected
const FREEZE_RISK_TAG = "FREEZE-RISK";
const METEO_TAG = "METEO";

interface WeatherCheckPayload {
  order_id: string;
  order_name: string;
  city: string;
  province_code?: string;
  country_code: string;
}

interface GeocodingResult {
  name: string;
  lat: number;
  lon: number;
  country: string;
  state?: string;
}

interface DailyForecast {
  dt: number;
  temp: {
    day: number;
    min: number;
    max: number;
    night: number;
    eve: number;
    morn: number;
  };
  weather: Array<{
    main: string;
    description: string;
  }>;
}

interface OneCallResponse {
  lat: number;
  lon: number;
  timezone: string;
  daily: DailyForecast[];
}

export async function POST(request: NextRequest) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Weather-Check] Received request`);

  try {
    // Validate API keys
    if (!OPENWEATHER_API_KEY) {
      console.error(`[${timestamp}] [Weather-Check] Missing OPENWEATHER_API_KEY`);
      return NextResponse.json(
        { error: "Weather API not configured" },
        { status: 500 }
      );
    }

    if (!SHOPIFY_TOKEN) {
      console.error(`[${timestamp}] [Weather-Check] Missing Shopify token`);
      return NextResponse.json(
        { error: "Shopify API not configured" },
        { status: 500 }
      );
    }

    // Parse payload
    const payload: WeatherCheckPayload = await request.json();
    console.log(`[${timestamp}] [Weather-Check] Payload:`, JSON.stringify(payload));

    const { order_id, order_name, city, province_code, country_code } = payload;

    if (!order_id || !city || !country_code) {
      return NextResponse.json(
        { error: "Missing required fields: order_id, city, country_code" },
        { status: 400 }
      );
    }

    // Step 1: Geocoding - convert city to lat/lon
    const locationQuery = province_code
      ? `${city},${province_code},${country_code}`
      : `${city},${country_code}`;

    console.log(`[${timestamp}] [Weather-Check] Geocoding: ${locationQuery}`);

    const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(locationQuery)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
    const geoResponse = await fetch(geoUrl);

    if (!geoResponse.ok) {
      const errorText = await geoResponse.text();
      console.error(`[${timestamp}] [Weather-Check] Geocoding API error:`, errorText);
      return NextResponse.json({
        success: true,
        warning: "Could not geocode location",
        error_details: errorText,
        order_name,
        freeze_risk: false,
        tag_added: false
      });
    }

    const geoData: GeocodingResult[] = await geoResponse.json();

    if (!geoData || geoData.length === 0) {
      console.error(`[${timestamp}] [Weather-Check] No geocoding results for: ${locationQuery}`);
      return NextResponse.json({
        success: true,
        warning: "Location not found",
        order_name,
        freeze_risk: false,
        tag_added: false
      });
    }

    const { lat, lon, name: geoName, country: geoCountry } = geoData[0];
    console.log(`[${timestamp}] [Weather-Check] Geocoded to: ${geoName}, ${geoCountry} (${lat}, ${lon})`);

    // Step 2: One Call 3.0 - get 8-day forecast
    const oneCallUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=current,minutely,hourly,alerts&units=metric&appid=${OPENWEATHER_API_KEY}`;

    console.log(`[${timestamp}] [Weather-Check] Fetching 8-day forecast...`);
    const weatherResponse = await fetch(oneCallUrl);

    if (!weatherResponse.ok) {
      const errorText = await weatherResponse.text();
      console.error(`[${timestamp}] [Weather-Check] One Call API error:`, errorText);

      return NextResponse.json({
        success: true,
        warning: "Could not fetch weather data",
        error_details: errorText,
        order_name,
        location: `${geoName}, ${geoCountry}`,
        freeze_risk: false,
        tag_added: false
      });
    }

    const forecast: OneCallResponse = await weatherResponse.json();
    console.log(`[${timestamp}] [Weather-Check] Got ${forecast.daily.length}-day forecast for ${geoName}, ${geoCountry}`);

    // Check if any day has freezing temperatures
    let freezeRisk = false;
    let lowestTemp = 100;
    let freezingDays: string[] = [];

    for (const day of forecast.daily) {
      const tempMin = day.temp.min;
      if (tempMin < lowestTemp) lowestTemp = tempMin;

      if (tempMin <= FREEZE_THRESHOLD_CELSIUS) {
        freezeRisk = true;
        const date = new Date(day.dt * 1000).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric'
        });
        freezingDays.push(`${date} (${tempMin.toFixed(1)}°C)`);
      }
    }

    console.log(`[${timestamp}] [Weather-Check] Lowest temp in ${forecast.daily.length} days: ${lowestTemp}°C, Freeze risk: ${freezeRisk}`);
    if (freezeRisk) {
      console.log(`[${timestamp}] [Weather-Check] Freezing days: ${freezingDays.join(', ')}`);
    }

    // If freeze risk, add tags to order
    let tagAdded = false;
    if (freezeRisk) {
      const freezeTagAdded = await addTagToOrder(order_id, FREEZE_RISK_TAG, timestamp);
      const meteoTagAdded = await addTagToOrder(order_id, METEO_TAG, timestamp);
      tagAdded = freezeTagAdded && meteoTagAdded;
    }

    return NextResponse.json({
      success: true,
      order_name,
      location: `${geoName}, ${geoCountry}`,
      coordinates: { lat, lon },
      forecast_days: forecast.daily.length,
      lowest_temp_celsius: lowestTemp,
      freeze_risk: freezeRisk,
      freezing_days: freezingDays,
      tag_added: tagAdded
    });

  } catch (error) {
    console.error(`[${timestamp}] [Weather-Check] Error:`, error);
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    );
  }
}

/**
 * Add a tag to a Shopify order using GraphQL
 */
async function addTagToOrder(orderId: string, tag: string, timestamp: string): Promise<boolean> {
  try {
    // Normalize order ID to GID format
    let orderGid = orderId;
    if (!orderId.startsWith('gid://')) {
      // If it's just a number, convert to GID
      orderGid = `gid://shopify/Order/${orderId}`;
    }

    console.log(`[${timestamp}] [Weather-Check] Adding tag to order. Input: ${orderId}, GID: ${orderGid}`);

    // First, get current tags
    const getTagsQuery = `
      query getOrderTags($id: ID!) {
        order(id: $id) {
          id
          tags
        }
      }
    `;

    const adminBase = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}`;

    const getResponse = await fetch(`${adminBase}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      },
      body: JSON.stringify({
        query: getTagsQuery,
        variables: { id: orderGid }
      }),
    });

    const getData = await getResponse.json();
    console.log(`[${timestamp}] [Weather-Check] Get tags response:`, JSON.stringify(getData));

    if (getData.errors) {
      console.error(`[${timestamp}] [Weather-Check] Error fetching order tags:`, JSON.stringify(getData.errors));
      return false;
    }

    if (!getData.data?.order) {
      console.error(`[${timestamp}] [Weather-Check] Order not found with GID: ${orderGid}`);
      return false;
    }

    const currentTags: string[] = getData.data?.order?.tags || [];

    // Check if tag already exists
    if (currentTags.includes(tag)) {
      console.log(`[${timestamp}] [Weather-Check] Tag "${tag}" already exists on order`);
      return true;
    }

    // Add new tag
    const newTags = [...currentTags, tag];

    const updateTagsMutation = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateResponse = await fetch(`${adminBase}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      },
      body: JSON.stringify({
        query: updateTagsMutation,
        variables: {
          input: {
            id: orderGid,
            tags: newTags
          }
        }
      }),
    });

    const updateData = await updateResponse.json();
    console.log(`[${timestamp}] [Weather-Check] Update tags response:`, JSON.stringify(updateData));

    if (updateData.errors || updateData.data?.orderUpdate?.userErrors?.length > 0) {
      console.error(`[${timestamp}] [Weather-Check] Error updating tags:`,
        JSON.stringify(updateData.errors || updateData.data?.orderUpdate?.userErrors));
      return false;
    }

    console.log(`[${timestamp}] [Weather-Check] Successfully added tag "${tag}" to order`);
    return true;

  } catch (error) {
    console.error(`[${timestamp}] [Weather-Check] Error adding tag:`, error);
    return false;
  }
}

// Health check
export async function GET() {
  return NextResponse.json({
    status: "ok",
    endpoint: "weather-check",
    api: "OpenWeather One Call 3.0",
    forecast_days: 8,
    freeze_threshold_celsius: FREEZE_THRESHOLD_CELSIUS,
    tags_added: [FREEZE_RISK_TAG, METEO_TAG],
    description: "Checks 8-day weather forecast for Holy Water orders and adds FREEZE-RISK and METEO tags if freezing temperatures expected"
  });
}
