import type { ActionFunctionArgs } from "react-router";
import crypto from "crypto";
import { authenticate } from "../shopify.server"; // adattalo se il path è diverso

function verifyHmac(raw: string, hmac: string, secret: string) {
  const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac || "")); }
  catch { return false; }
}

function toKg(grams?: number) {
  const g = Number(grams || 0);
  const kg = g > 0 ? g / 1000 : 0.05; // default 50 g
  return Math.max(0.01, Number(kg.toFixed(3)));
}

function defaultParcel(order: any) {
  const totalGrams =
    (order?.line_items || []).reduce((s: number, it: any) => s + (it.grams || 0), 0) ||
    order?.total_weight || 0;
  return { weight: toKg(totalGrams), length: 7, width: 8, height: 3 };
}

function buildParties(order: any) {
  const to = order.shipping_address || {};
  return {
    consignee: {
      country: to.country_code,
      city: to.city,
      zip: to.zip,
      province: to.province_code || to.province || "",
      consigneeAddressLine1: to.address1 || "",
      consigneeAddressLine2: to.address2 || "",
      consigneeAddressLine3: "",
      contactName: `${to.first_name || ""} ${to.last_name || ""}`.trim(),
      phone: to.phone || order.phone || "",
      email: order.email || "",
    },
    sender: {
      country: process.env.SENDER_COUNTRY || "IT",
      city: process.env.SENDER_CITY || "Roma",
      zip: process.env.SENDER_ZIP || "00100",
      province: process.env.SENDER_PROV || "RM",
      senderAddressLine1: process.env.SENDER_ADDR1 || "",
      senderAddressLine2: process.env.SENDER_ADDR2 || "",
      senderAddressLine3: "",
      contactName: process.env.SENDER_NAME || "Catholically",
      phone: process.env.SENDER_PHONE || "",
      email: process.env.SENDER_EMAIL || "",
    },
  };
}

async function spLogin() {
  const r = await fetch(`${process.env.SPEDIREPRO_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.SPEDIREPRO_USER,
      password: process.env.SPEDIREPRO_PASS,
    }),
  });
  if (!r.ok) throw new Error(`SpedirePro login failed: ${r.status}`);
  const j = await r.json();
  if (!j.token) throw new Error("SpedirePro login missing token");
  return j.token;
}

async function createLabelForOrder(order: any) {
  const token = await spLogin();

  const simPayload = {
    externalReference: order.name,
    externalId: String(order.id),
    ...buildParties(order),
    parcels: [defaultParcel(order)],
    // customs: {...} // se extra-UE
  };

  const simRes = await fetch(`${process.env.SPEDIREPRO_BASE}/api/v1/simulazione`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(simPayload),
  });
  if (!simRes.ok) throw new Error(`simulation failed: ${simRes.status}`);
  const sim = await simRes.json();

  const best = sim?.tariffe?.[0] || sim?.rates?.[0];
  const simulationId = sim?.id || sim?.simulationId || best?.simulationId;
  const tariffCode = best?.tariffCode || best?.code;
  if (!simulationId || !tariffCode) throw new Error("missing simulationId/tariffCode");

  const makeRes = await fetch(
    `${process.env.SPEDIREPRO_BASE}/api/v1/spedizione/${encodeURIComponent(simulationId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tariffCode, labelFormat: 0 }), // 0=PDF, 1=GIF, 2=ZPL
    }
  );
  if (!makeRes.ok) throw new Error(`shipment create failed: ${makeRes.status}`);
  const made = await makeRes.json();

  const tracking =
    made.tracking || made.trackingNumber || made.shipment?.tracking || made?.data?.tracking;
  const trackingUrl =
    made.tracking_url || made.trackingUrl || made.shipment?.trackingUrl || made?.data?.trackingUrl;
  const labelUrl =
    made.label_url || made.labelUrl || made.shipment?.labelUrl || made?.data?.labelUrl;

  if (!tracking || !labelUrl) throw new Error("missing tracking/labelUrl");
  return { tracking, trackingUrl: trackingUrl || null, labelUrl };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const raw = await request.text();
  const hmac = request.headers.get("x-shopify-hmac-sha256") || "";
  if (!verifyHmac(raw, hmac, process.env.SHOPIFY_WEBHOOK_SECRET!)) {
    return new Response("unauthorized", { status: 401 });
  }

  const ev = JSON.parse(raw);
  const orderId = ev.id as number;
  const name = ev.name as string;
  const tags = String(ev.tags || "")
    .split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);

  const hasTrigger = tags.includes("CREATE-LABEL");
  const alreadyDone = tags.includes("LABEL-DONE");
  if (!hasTrigger || alreadyDone) return new Response("ok");

  const label = await createLabelForOrder(ev);

  const { admin } = await authenticate.admin(request, { isOnline: false });

  await admin.rest.post({
    path: "/metafields.json",
    data: {
      metafield: {
        owner_id: orderId,
        owner_resource: "order",
        namespace: "shipping",
        key: "label_info",
        type: "json",
        value: JSON.stringify({
          tracking: label.tracking,
          tracking_url: label.trackingUrl,
          label_url: label.labelUrl,
          source: "spedirepro",
          order_name: name,
        }),
      },
    },
  });

  const newTags = Array.from(new Set([...tags, "LABEL-DONE"])).join(", ");
  await admin.rest.put({
    path: `/orders/${orderId}.json`,
    data: { order: { id: orderId, tags: newTags } },
  });

  // Opzionale: crea fulfillment qui

  return new Response("ok");
};

export const loader = async () => new Response("Not Found", { status: 404 });
