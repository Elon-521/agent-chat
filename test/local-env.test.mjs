import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

test("local server loads .env beside server.mjs when launched from another folder", { timeout: 12000 }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "agent-chat-env-test-"));
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let child;
  let forwarded;
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    forwarded = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ output: { text: "fixture reply", session_id: "fixture_session" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  try {
    await cp(path.join(project, "server.mjs"), path.join(fixture, "server.mjs"));
    await cp(path.join(project, "src"), path.join(fixture, "src"), { recursive: true });
    await writeFile(path.join(fixture, ".env"), [
      "DASHSCOPE_API_KEY=fixture-key",
      "DASHSCOPE_APP_ID=fixture-app",
      `DASHSCOPE_BASE_URL=http://127.0.0.1:${upstream.address().port}`,
      "",
    ].join("\n"));
    const env = { ...process.env, PORT: String(port) };
    for (const key of Object.keys(env)) {
      if (key.startsWith("DASHSCOPE_") || key === "NODE_OPTIONS") delete env[key];
    }
    child = spawn(process.execPath, [path.join(fixture, "server.mjs")], { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Fixture server startup timed out")), 5000);
      child.stdout.on("data", (data) => {
        if (String(data).includes("Agent chat server listening")) { clearTimeout(timeout); resolve(); }
      });
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Fixture server exited before readiness")); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "configuration test" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "fixture reply", sessionId: "fixture_session" });
    assert.equal(forwarded.url, "/api/v1/apps/fixture-app/completion");
    assert.equal(forwarded.authorization, "Bearer fixture-key");
    assert.equal(forwarded.body.input.prompt, "configuration test");
  } finally {
    if (child && child.exitCode === null) {
      await new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
    }
    await new Promise((resolve) => upstream.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});
