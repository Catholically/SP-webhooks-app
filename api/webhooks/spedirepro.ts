import type { NextRequest } from "next/server";
export const config = { runtime: "edge" };

function ok(d:any={}) { return new Response(JSON.stringify({ ok:true, ...d }), { status:200 }); }
function bad(s:number,m:string,d?:any) { return new Response(JSON.stringify({ ok:false, error:m, ...(d?{detail:d}:{}) }), { status:s }); }

const WEBHOOK_TOKEN = (process.env.SPRO_WEBHOOK_TOKEN || "").trim();

async function readBody(req: NextRequest) {
  // 1) JSON
  try { return { kind:"json", data: await req.json() }; } catch {}
  // 2) Form-encoded
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      const txt = await req.text();
      const params = new URLSearchParams(txt);
      const obj: Record<string,string> = {};
      params.forEach((v,k)=>{ obj[k]=v; });
      return { kind:"form", data: obj };
    }
  } catch {}
  // 3) Raw text
  try { return { kind:"text", data: await req.text() }; } catch {}
  return { kind:"none", data: null };
}

export default async function handler(req: NextRequest) {
  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();

  // Log ingresso minimale
  console.log("spedirepro: hit", { method:req.method, ua:req.headers.get("user-agent") || "", hasToken: !!token });

  // Token check molto permissivo per debug iniziale
  if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
    return bad(400, "invalid-token");
  }

  // SpedirePRO può pingare in GET per la verifica → rispondi 200
  if (req.method === "GET" || req.method === "HEAD") {
    return ok({ ping:true });
  }

  if (req.method !== "POST") return bad(405, "method-not-allowed");

  const body = await readBody(req);
  console.log("spedirepro: parsed", body.kind);

  // Normalizza payload in uno shape comune
  let payload: any = {};
  if (body.kind === "json" && body.data) payload = body.data;
  else if (body.kind === "form" && body.data) payload = body.data;
  else if (body.kind === "text" && typeof body.data === "string") {
    try { payload = JSON.parse(body.data); } catch { payload = { raw: body.data }; }
  } else {
    return bad(400, "empty-body");
  }

  // Estrai campi tipici se presenti
  const merchantRef  = payload.merchant_reference || payload.merchantRef || payload.name;
  const reference    = payload.reference || payload.order || payload.shipment || payload.shipment_number;
  const tracking     = payload.tracking || payload.tracking_number || payload.trackingNum;
  const tracking_url = payload.tracking_url || payload.trackingUrl;
  const label_url    = payload.label?.link || payload.label_url || payload.labelUrl;

  console.log("spedirepro: incoming", {
    merchantRef, reference, tracking, hasLabel: !!label_url
  });

  // TODO: qui crea fulfillment e aggiorna metafield, se vuoi.
  // Per ora conferma ricezione per far passare la verifica SPRO.
  return ok({ received:true });
}
