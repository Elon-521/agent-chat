import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { callBailian } from "./src/chat-server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  loadEnvFile(path.join(root, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const dist = path.join(root, "dist");

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function applyCors(res, req) {
  const configuredOrigin = process.env.ALLOWED_ORIGIN || "http://127.0.0.1:5173";
  if (req.headers.origin === configuredOrigin) res.setHeader("Access-Control-Allow-Origin", configuredOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
}

function serveStatic(res, urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(dist, requested));
  if (!filePath.startsWith(dist) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    const fallback = path.join(dist, "index.html");
    if (!existsSync(fallback)) return false;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(fallback));
    return true;
  }
  const ext = path.extname(filePath);
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath));
  return true;
}

const server = createServer(async (req, res) => {
  applyCors(res, req);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "POST" && req.url === "/api/chat") {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 32_000) return sendJson(res, 413, { error: "请求内容太大了。" });
    }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { error: "请求格式不正确。" }); }
    const result = await callBailian({ prompt: body.prompt, sessionId: body.sessionId, env: process.env });
    return sendJson(res, result.status, result.body);
  }
  if (req.method === "GET" && serveStatic(res, new URL(req.url, "http://localhost").pathname)) return;
  return sendJson(res, 404, { error: "页面不存在。" });
});

server.listen(port, host, () => {
  console.log(`Agent chat server listening on http://${host}:${port}`);
});
