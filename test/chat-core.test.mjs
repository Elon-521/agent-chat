import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBailianPayload,
  extractBailianReply,
  validateChatInput,
} from "../src/chat-core.mjs";

test("builds a single-turn Bailian completion payload", () => {
  assert.deepEqual(buildBailianPayload("  牙龈肿痛  "), {
    input: { prompt: "牙龈肿痛" },
    parameters: {},
    debug: {},
  });
});

test("includes a visitor session id for a follow-up turn", () => {
  assert.deepEqual(buildBailianPayload("继续", "sess_123"), {
    input: { prompt: "继续", session_id: "sess_123" },
    parameters: {},
    debug: {},
  });
});

test("extracts the assistant text and session id", () => {
  assert.deepEqual(
    extractBailianReply({ output: { text: "请描述疼痛位置", session_id: "sess_next" } }),
    { text: "请描述疼痛位置", sessionId: "sess_next" },
  );
});

test("rejects blank or oversized prompts", () => {
  assert.equal(validateChatInput("   "), "请输入你想咨询的内容。");
  assert.equal(validateChatInput("a".repeat(4001)), "内容太长了，请分段发送。");
  assert.equal(validateChatInput("牙龈出血"), null);
});
