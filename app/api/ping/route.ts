export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // o 'edge'

export async function GET() {
  return Response.json({ ok: true, ping: 'ok' });
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}
