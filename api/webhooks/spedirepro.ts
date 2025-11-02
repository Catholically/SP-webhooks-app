// api/webhooks/spedirepro.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

/**
 * SpedirePro webhook receiver
 *
 * Env variables required:
 * - SPRO_WEBHOOK_TOKEN    shared secret for webhook validation
 *
 * Notes:
 * SpedirePro will POST here after asynchronous events (label creation, etc.)
 * using the endpoint configured under IMPOSTAZIONI → App e Integrazioni → API
 */

function json(status: number, data: any) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const ok  = (d:any={}) => json(200, { ok:true, ...d });
const bad = (s:number,e:string,x?:any)=> json(s, { ok:false, error:e, ...(x??{}) });

async function parseBody(req: NextRequest) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) return await req.json();
    if (ct.includes("application/x-www-form-urlencoded")) {
      const raw = await req.text();
      const params = new URLSearchParams(raw);
      const obj: Record<string,string> = {};
      for (const [k,v] of params.entries()) obj[k]=v;
      if (obj.payload) { try { return JSON.parse(obj.payload); } catch { return obj; } }
      return obj;
    }
    const raw = await req.text();
    try { return JSON.parse(raw); } catch { return { raw }; }
  } catch { return null; }
}

type Extracted = {
  merchant_reference?: string;
  reference?: string;
  tracking?: string;
  tracking_url?: string;
  label_url?: string;
};

const pick = (...v:any[]) => v.find(x => x !== undefined && x !== null && x !== "");

function extract(b:any): Extracted {
  if (!b || typeof b !== "object") return {};
  const merchant_reference = pick(b.merchant_reference, b.merchantRef, b.order_name, b.order, b.name);
  const reference           = pick(b.reference, b.shipment, b.shipment_number, b.ref, b.id);
  const tracking            = pick(b.tracking, b.tracking_number, b.trackingNumber);
  const tracking_url        = pick(b.tracking_url, b.trackingUrl, b.tracking_link, b.trackingLink);
  const label_url           = pick(b.label?.link, b.label?.url, b.label_url, b.labelUrl);
  return { merchant_reference, reference, tracking, tracking_url, label_url };
}

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") return bad(405, "method-not-allowed");

  // Validate token to prevent spoofing
  const expected = process.env.SPRO_WEBHOOK_TOKEN || "";
  if (!expected) return bad(500, "missing-env-SPRO_WEBHOOK_TOKEN");
  const provided = new URL(req.url).searchParams.get("token") || req.headers.get("x-webhook-token") || "";
  if (provided !== expected) return bad(401, "invalid-token");

  const body = await parseBody(req);
  if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
    return ok({ skipped: true, reason: "empty-payload" });
  }

  const ex = extract(body);

  // Basic log for verification (visible in console)
  console.log("SpedirePro webhook received", {
    merchant_reference: ex.merchant_reference,
    reference: ex.reference,
    tracking: ex.tracking,
    label: ex.label_url ? "yes" : "no"
  });

  return ok({
    received: true,
    merchant_reference: ex.merchant_reference || null,
    reference: ex.reference || null,
    tracking: ex.tracking || null,
    tracking_url: ex.tracking_url || null,
    label_url: ex.label_url || null,
  });
}
