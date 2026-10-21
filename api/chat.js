import { callBailian } from "../src/chat-server.mjs";

function applyCors(res, req) {
  const configuredOrigin = process.env.ALLOWED_ORIGIN || "";
  const requestOrigin = req.headers?.origin;
  if (configuredOrigin && requestOrigin === configuredOrigin) res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
}

export default async function handler(req, res) {
  applyCors(res, req);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "只支持 POST 请求。" });

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "请求格式不正确。" }); }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "请求格式不正确。" });
  }
  const result = await callBailian({
    prompt: body.prompt,
    sessionId: body.sessionId,
    env: process.env,
  });
  return res.status(result.status).json(result.body);
}
