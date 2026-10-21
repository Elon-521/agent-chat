import test from "node:test";
import assert from "node:assert/strict";
import { callBailian } from "../src/chat-server.mjs";

test("rejects non-string prompts before contacting Bailian", async () => {
  let called = false;
  const result = await callBailian({
    prompt: { unexpected: true },
    env: { DASHSCOPE_API_KEY: "key", DASHSCOPE_APP_ID: "app_test" },
    fetchImpl: async () => { called = true; },
  });
  assert.equal(result.status, 400);
  assert.equal(called, false);
});

test("forwards a valid prompt and returns the normalized reply", async () => {
  let request;
  const result = await callBailian({
    prompt: "牙龈出血",
    sessionId: "sess_123",
    env: { DASHSCOPE_API_KEY: "key", DASHSCOPE_APP_ID: "app_test" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ output: { text: "请描述疼痛位置", session_id: "sess_456" } }), { status: 200 });
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { text: "请描述疼痛位置", sessionId: "sess_456" });
  assert.equal(request.options.headers.Authorization, "Bearer key");
  assert.deepEqual(JSON.parse(request.options.body).input, { prompt: "牙龈出血", session_id: "sess_123" });
});

test("a managed Agent ID is never sent to the application completion API", async () => {
  let called = false;
  const result = await callBailian({
    prompt: "你好",
    env: { DASHSCOPE_API_KEY: "fixture-key", DASHSCOPE_APP_ID: "agent_example" },
    fetchImpl: async () => {
      called = true;
      return Response.json({ output: { text: "wrong protocol", session_id: "wrong_session" } });
    },
  });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /运行环境/);
  assert.equal(called, false);
});

test("routes configured managed Agents through a subscribed session event stream", async () => {
  const requests = [];
  let streamController;
  const encoder = new TextEncoder();
  const send = (data) => streamController.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`));
  const result = await callBailian({
    prompt: "  你好  ",
    env: {
      DASHSCOPE_API_KEY: "fixture-key",
      MANAGED_AGENT_ID: "agent_fixture",
      MANAGED_AGENT_ENVIRONMENT_ID: "env_fixture",
      MANAGED_AGENT_BASE_URL: "https://maas.qianwenaiapi.com/api/v1/agentstudio",
    },
    fetchImpl: async (url, options = {}) => {
      const route = new URL(url).pathname;
      requests.push({ route, options });
      assert.equal(options.headers.Authorization, "Bearer fixture-key");
      if (route === "/api/v1/agentstudio/sessions") {
        assert.deepEqual(JSON.parse(options.body), { agent: { type: "agent", id: "agent_fixture" }, environment_id: "env_fixture" });
        return Response.json({ id: "sesn_fixture", type: "session", status: "idle", agent: { id: "agent_fixture" }, environment_id: "env_fixture" });
      }
      if (route.endsWith("/events/stream")) {
        return new Response(new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(encoder.encode(": connected\n\n")); } }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (route.endsWith("/events")) {
        assert.ok(streamController, "subscribe before submitting a prompt");
        assert.deepEqual(JSON.parse(options.body), { input: [{ role: "user", type: "message", content: [{ type: "text", text: "你好" }] }] });
        send({ type: "session_status", content: [{ type: "data", data: { session_status: "running" } }] });
        send({ id: "msg_reply", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "你好，请问有什么需要帮助？" }] });
        send({ type: "session_status", content: [{ type: "data", data: { session_status: "idle", stop_reason: { type: "end_turn" } } }] });
        return Response.json({ data: [{ id: "msg_user", role: "user", type: "message" }] });
      }
      throw new Error(`Unexpected route: ${route}`);
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { text: "你好，请问有什么需要帮助？", sessionId: "sesn_fixture" });
  assert.equal(requests.length, 3);
});
