// api/webhooks/spedirepro.ts
import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

function ok(data: any = {}) {
  return new Response(JSON.stringify({ ok: true, ...data }), { status: 200 });
}
function bad(status: number, error: string, extra?: any) {
  return new Response(JSON.stringify({ ok: false, error, ...(extra ?? {}) }), { status });
}

async function parseBody(req: NextRequest): Promise<any> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) return await req.json();
    if (ct.includes("application/x-www-form-urlencoded")) {
      const txt = await req.text();
      const params = new URLSearchParams(txt);
      const o: Record<string, any> = {};
      for (const [k, v] of params.entries()) o[k] = v;
      // se qualcuno incapsula json in un campo "payload"
      if (o.payload) {
        try { return JSON.parse(o.payload); } catch {}
      }
      return o;
    }
    // fallback: prova JSON poi al testo puro
    try { return await req.json(); } catch {}
    return await req.text();
  } catch {
    return null;
  }
}

type Extracted = {
  merchantRef?: string;
  reference?: string;
  tracking?: string;
  trackingUrl?: string;
  labelUrl?: string;
};

function pickFirst(...vals: any[]): string | undefined {
  for (const v of vals) {
    if (v == null) continue;
    const s = typeof v === "string" ? v.trim() : v;
    if (typeof s === "string" && s) return s;
  }
  return undefined;
}

function extract(body: any): Extracted {
  if (!body || typeof body !== "object") return {};
  // molte possibili forme dai vari webhook
  const merchantRef = pickFirst(
    body.merchant_reference, body.merchantRef, body.merchant, body.order_name, body.order, body.name
  );
  const reference = pickFirst(
    body.reference, body.order, body.shipment, body.shipment_number, body.ref, body.id
  );
  const tracking = pickFirst(
    body.tracking, body.tracking_number, body.trackingNumber
  );
  const trackingUrl = pickFirst(
    body.tracking_url, body.trackingUrl, body.tracking_link, body.trackingLink, body.url_tracking
  );
  const labelUrl = pickFirst(
    body?.label?.link, body.label_link, body.labelUrl, body.label, body.url_label, body.label_url
  );

  return { merchantRef, reference, tracking, trackingUrl, labelUrl };
}

export default async function handler(req: NextRequest) {
  if (req.method !== "POST") return bad(405, "method-not-allowed");

  const ua = req.headers.get("user-agent") || "";
  const body = await parseBody(req);

  // estrai in modo resiliente
  const ex = extract(body);

  // log sintetico
  console.log("spedirepro: hit", {
    method: req.method,
    ua,
    hasToken: !!(new URL(req.url).searchParams.get("token")),
  });
  console.log("spedirepro: parsed json");

  const incoming = {
    merchantRef: ex.merchantRef,
    reference: ex.reference,
    tracking: ex.tracking,
    hasLabel: !!ex.labelUrl,
  };
  console.log("spedirepro: incoming", incoming);

  // se SpedirePro invia pings senza campi, rispondi 200 e termina
  const hasAny = ex.merchantRef || ex.reference || ex.tracking || ex.labelUrl || ex.trackingUrl;
  if (!hasAny) {
    // log di debug con uno spezzone del body per capire la forma reale
    const sample = typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400);
    console.warn("spedirepro: empty-or-unknown payload shape. sample:", sample);
    return ok({ skipped: true, reason: "empty-payload" });
  }

  // qui potresti: 1) fare fulfillment/tracking 2) salvare metafield label_url
  // Poiché questo endpoint è SOLO ricezione SPRO, limitiamoci a confermare.
  return ok({
    received: true,
    merchant_reference: ex.merchantRef || null,
    reference: ex.reference || null,
    tracking: ex.tracking || null,
    tracking_url: ex.trackingUrl || null,
    label_url: ex.labelUrl || null,
  });
}
