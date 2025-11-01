export const config = {
  runtime: "edge",
};

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (token !== process.env.SPRO_WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "invalid-token" }), { status: 401 });
  }

  let data;
  try {
    data = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid-json" }), { status: 400 });
  }

  console.log("spedirepro incoming", data);

  const { merchant_reference, reference, tracking, tracking_url } = data || {};
  if (!merchant_reference || !reference || !tracking || !tracking_url) {
    return new Response(JSON.stringify({ ok: false, error: "missing-order-fields" }), { status: 400 });
  }

  // TODO: qui puoi gestire l’aggiornamento ordine Shopify
  return new Response(JSON.stringify({ ok: true, step: "received", order: merchant_reference }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
