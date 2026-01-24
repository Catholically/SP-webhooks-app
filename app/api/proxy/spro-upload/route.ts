/**
 * Proxy endpoint for SpedirePro document upload
 * Used by SP-Label-Generator to bypass Cloudflare blocking
 *
 * SP-Label-Generator -> this proxy -> SpedirePro
 */

export const runtime = "nodejs";

const SPRO_WEB_BASE = "https://www.spedirepro.com";

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
 *   reference: string,      // SpedirePro reference
 *   tracking: string,       // Tracking number
 *   documentType: 1 | 2,    // 1 = invoice, 2 = declaration
 *   pdfBase64: string,      // PDF content as base64
 *   filename: string        // Original filename
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
    tracking: string;
    documentType: number;
    pdfBase64: string;
    filename: string;
  };

  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid json" });
  }

  const { reference, tracking, documentType, pdfBase64, filename } = body;

  if (!reference || !tracking || !documentType || !pdfBase64 || !filename) {
    return json(400, { ok: false, error: "missing required fields" });
  }

  const SPRO_API_KEY = process.env.SPRO_API_KEY;
  if (!SPRO_API_KEY) {
    console.error("[Proxy] SPRO_API_KEY not configured");
    return json(500, { ok: false, error: "server configuration error" });
  }

  try {
    // Convert base64 to buffer
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    console.log(`[Proxy] Uploading document type ${documentType} for reference ${reference} (${pdfBuffer.length} bytes)`);

    // Step 1: Upload the file to SpedirePro
    const formData = new FormData();
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    formData.append('document', blob, filename);

    const uploadResponse = await fetch(
      `${SPRO_WEB_BASE}/api/documents/dogana/upload`,
      {
        method: 'POST',
        headers: {
          'X-Api-Key': SPRO_API_KEY,
        },
        body: formData,
      }
    );

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error(`[Proxy] Upload failed: ${uploadResponse.status} ${errorText.substring(0, 200)}`);
      return json(uploadResponse.status, {
        ok: false,
        error: "upload failed",
        status: uploadResponse.status,
        details: errorText.substring(0, 500)
      });
    }

    console.log(`[Proxy] File uploaded successfully, confirming...`);

    // Step 2: Confirm the upload with document type
    const filePath = `${tracking}_${documentType}_${reference}.pdf`;
    const confirmResponse = await fetch(
      `${SPRO_WEB_BASE}/api/user/shipment/customs-uploaded`,
      {
        method: 'POST',
        headers: {
          'X-Api-Key': SPRO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reference: reference,
          document_type: documentType,
          file_path: filePath,
        }),
      }
    );

    if (!confirmResponse.ok) {
      const errorText = await confirmResponse.text();
      console.error(`[Proxy] Confirm failed: ${confirmResponse.status} ${errorText.substring(0, 200)}`);
      return json(confirmResponse.status, {
        ok: false,
        error: "confirm failed",
        status: confirmResponse.status,
        details: errorText.substring(0, 500)
      });
    }

    console.log(`[Proxy] ✅ Document type ${documentType} uploaded and confirmed for reference ${reference}`);
    return json(200, { ok: true, documentType, reference });

  } catch (error) {
    console.error('[Proxy] Error:', error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
}
