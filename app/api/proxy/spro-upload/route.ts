/**
 * Proxy endpoint for SpedirePro document upload
 * Used by SP-Label-Generator to bypass Cloudflare blocking
 *
 * SP-Label-Generator -> this proxy -> SpedirePro
 *
 * Updated January 2026 for new SpedirePro API
 * @see https://spedirepro.readme.io/reference/upload-documentazione-doganale
 */

export const runtime = "nodejs";

const SPRO_API_BASE = "https://www.spedirepro.com/public-api/v1";

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }
  });

// Handle CORS preflight
export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/**
 * POST /api/proxy/spro-upload
 *
 * Body (JSON):
 * {
 *   reference: string,                           // SpedirePro reference
 *   documentType: 'invoice' | 'export_declaration',  // Document type (new API)
 *   pdfBase64: string,                           // PDF content as base64
 *   filename: string                             // Original filename
 * }
 *
 * Authorization: Bearer <PROXY_SECRET>
 */
export async function POST(req: Request) {
  // Verify authorization
  const authHeader = req.headers.get("authorization") || "";
  const proxySecret = process.env.SPRO_PROXY_SECRET || "";

  if (!proxySecret || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== proxySecret) {
    console.log("[Proxy] Unauthorized request");
    return json(401, { ok: false, error: "unauthorized" });
  }

  // Parse body
  let body: {
    reference: string;
    documentType: string;  // 'invoice' or 'export_declaration'
    pdfBase64: string;
    filename: string;
  };

  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid json" });
  }

  const { reference, documentType, pdfBase64, filename } = body;

  if (!reference || !documentType || !pdfBase64 || !filename) {
    return json(400, { ok: false, error: "missing required fields" });
  }

  // Validate document type
  if (documentType !== 'invoice' && documentType !== 'export_declaration') {
    return json(400, { ok: false, error: "invalid documentType, must be 'invoice' or 'export_declaration'" });
  }

  const SPRO_API_KEY = process.env.SPRO_API_KEY;
  if (!SPRO_API_KEY) {
    console.error("[Proxy] SPRO_API_KEY not configured");
    return json(500, { ok: false, error: "server configuration error" });
  }

  try {
    // Convert base64 to buffer
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    console.log(`[Proxy] Uploading document type "${documentType}" for reference ${reference} (${pdfBuffer.length} bytes)`);

    // Single-step upload to new SpedirePro API
    const formData = new FormData();
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    formData.append('document', blob, filename);
    formData.append('document_type', documentType);

    const response = await fetch(
      `${SPRO_API_BASE}/shipment/${reference}/upload`,
      {
        method: 'POST',
        headers: {
          'X-Api-Key': SPRO_API_KEY,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Proxy] Upload failed: ${response.status} ${errorText.substring(0, 200)}`);
      return json(response.status, {
        ok: false,
        error: "upload failed",
        status: response.status,
        details: errorText.substring(0, 500)
      });
    }

    console.log(`[Proxy] ✅ Document type "${documentType}" uploaded successfully for reference ${reference}`);
    return json(200, { ok: true, documentType, reference });

  } catch (error) {
    console.error('[Proxy] Error:', error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
}
