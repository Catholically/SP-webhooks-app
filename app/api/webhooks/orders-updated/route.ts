export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  // placeholder: verifica token o HMAC qui
  return Response.json({ ok: true, route: 'orders-updated' });
}

export async function GET() {
  return new Response('Method Not Allowed', { status: 405 });
}
