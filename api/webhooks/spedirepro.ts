// api/webhooks/spedirepro.ts
import type { NextApiRequest, NextApiResponse } from "next";

export const config = { api: { bodyParser: false } }; // leggiamo raw body

async function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Healthcheck
  if (req.method === "GET") return res.status(200).json({ ok: true, ping: "spedirepro" });

  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

  const expected = process.env.SPRO_WEBHOOK_TOKEN || "";
  const token = String(req.query?.token || req.headers["x-webhook-token"] || "");
  if (!expected || token !== expected) return res.status(401).json({ ok:false, error:"unauthorized" });

  const raw = await readRawBody(req);
  console.log("[SPRO-WH] raw:", raw.slice(0,200));
  return res.status(200).json({ ok:true, raw_len: raw.length, raw_preview: raw.slice(0,200) });
}
