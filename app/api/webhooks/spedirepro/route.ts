export const runtime = "nodejs";

export async function POST() {
  return Response.json({ ok: true, ping: "spedirepro" });
}
export async function GET() { return new Response("method-not-allowed", { status: 405 }); }
export async function HEAD() { return new Response(null, { status: 405 }); }
