import test from "node:test";
import assert from "node:assert/strict";
import { callManagedAgent } from "../src/managed-agent.mjs";

const base = "https://maas.qianwenaiapi.com/api/v1/agentstudio";
const config = {
  apiKey: "sk-test-secret",
  agentId: "agent_01M5F13VM60RY58FXBBVM9HMVR",
  environmentId: "env_ZjZjYTdjNDlhZWQzNDQ2ZW",
  baseUrl: base,
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function assistantEvent(id, text) {
  return `event: message\r\ndata: ${JSON.stringify({
    object: "message",
    id,
    role: "assistant",
    type: "message",
    status: "completed",
    content: [{ type: "text", text }],
  })}\r\n\r\n`;
}

function statusEvent(sessionStatus, stopReason) {
  const data = { session_status: sessionStatus };
  if (stopReason) data.stop_reason = stopReason;
  return `event: message\r\ndata: ${JSON.stringify({
    object: "message",
    id: `status-${sessionStatus}-${stopReason?.type || "none"}`,
    type: "session_status",
    status: "completed",
    content: [{ type: "data", data }],
  })}\r\n\r\n`;
}

test("opens SSE before posting a new user event and returns the current assistant turn", async () => {
  const calls = [];
  const encoder = new TextEncoder();
  let streamController;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return jsonResponse({ id: "sesn_new" });
    if (calls.length === 2) {
      return new Response(new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(encoder.encode(": conn"));
          controller.enqueue(encoder.encode("ected\r\n\r\n"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    streamController.enqueue(encoder.encode(`${statusEvent("idle")}${statusEvent("running")}`));
    streamController.enqueue(encoder.encode(assistantEvent("msg-1", "请描述")));
    streamController.enqueue(encoder.encode(assistantEvent("msg-2", "疼痛位置")));
    streamController.enqueue(encoder.encode(statusEvent("idle", { type: "end_turn" })));
    streamController.close();
    return jsonResponse({ data: [], request_id: "req-event" });
  };

  const result = await callManagedAgent({ prompt: "  牙龈出血  ", ...config, fetchImpl });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { text: "请描述\n疼痛位置", sessionId: "sesn_new" });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/sessions$/);
  assert.match(calls[1].url, /\/sessions\/sesn_new\/events\/stream$/);
  assert.match(calls[2].url, /\/sessions\/sesn_new\/events$/);
  assert.equal(calls[1].options.headers.Accept, "text/event-stream");
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    input: [{ role: "user", type: "message", content: [{ type: "text", text: "牙龈出血" }] }],
  });
});

test("accepts the platform's connected SSE comment without a space", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/sessions")) return jsonResponse({ id: "sesn_connected" });
    if (url.endsWith("/events/stream")) return streamResponse([
      ":connected\n\n",
      statusEvent("running"),
      assistantEvent("msg-connected", "已连接"),
      statusEvent("idle", { type: "end_turn" }),
    ]);
    return jsonResponse({ data: [] });
  };
  const result = await callManagedAgent({ prompt: "测试连接", ...config, fetchImpl, timeoutMs: 1000 });
  assert.equal(result.status, 200);
  assert.equal(result.body.text, "已连接");
});

test("validates a reused session before sending the next turn", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return jsonResponse({ id: "sesn_existing", agent: { id: config.agentId }, environment_id: config.environmentId });
    }
    if (calls.length === 2) {
      return streamResponse([": connected\n\n", statusEvent("running"), assistantEvent("msg-2", "好的"), statusEvent("idle", { type: "end_turn" })]);
    }
    return jsonResponse({ data: [] });
  };

  const result = await callManagedAgent({ prompt: "继续", sessionId: "sesn_existing", ...config, fetchImpl });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { text: "好的", sessionId: "sesn_existing" });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/sessions\/sesn_existing$/);
  assert.equal(calls[0].options.method, "GET");
});

test("rejects a reused session belonging to another Agent", async () => {
  let calls = 0;
  const result = await callManagedAgent({
    prompt: "继续",
    sessionId: "sesn_other",
    ...config,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ id: "sesn_other", agent: { id: "agent_other" }, environment_id: config.environmentId });
    },
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /会话无效/);
  assert.equal(result.body.sessionId, "sesn_other");
  assert.equal(calls, 1);
});

test("returns a safe approval-needed response and preserves the session", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/sessions")) return jsonResponse({ id: "sesn_approval" });
    if (url.endsWith("/events/stream")) {
      return streamResponse([
        ": connected\n\n",
        statusEvent("running"),
        `event: message\ndata: ${JSON.stringify({ type: "tool_approval_request", role: "assistant", content: [{ type: "data", data: { batch_id: "batch-1", call_id: "call-1", name: "bash" } }] })}\n\n`,
        statusEvent("idle", { type: "requires_action", pending_batch_id: "batch-1", pending_call_ids: ["call-1"] }),
      ]);
    }
    return jsonResponse({ data: [] });
  };

  const result = await callManagedAgent({ prompt: "查一下", ...config, fetchImpl });

  assert.equal(result.status, 409);
  assert.equal(result.body.sessionId, "sesn_approval");
  assert.match(result.body.error, /审批/);
  assert.doesNotMatch(JSON.stringify(result.body), /batch-1|call-1|bash/);
});

test("does not expose upstream error details or secrets", async () => {
  const result = await callManagedAgent({
    prompt: "测试",
    ...config,
    fetchImpl: async () => jsonResponse({ code: "InternalSecretCode", message: "sk-test-secret leaked" }, 403),
  });

  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result.body), /InternalSecretCode|sk-test-secret|403/);
});

test("returns timeout safely when the event stream never connects", async () => {
  let cancelled = false;
  const hangingBody = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = async (url) => {
    if (url.endsWith("/sessions")) return jsonResponse({ id: "sesn_timeout" });
    return new Response(hangingBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const result = await callManagedAgent({ prompt: "测试", ...config, timeoutMs: 20, fetchImpl });

  assert.equal(result.status, 504);
  assert.match(result.body.error, /超时/);
  assert.equal(cancelled, true);
});
