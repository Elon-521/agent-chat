export function validateChatInput(value) {
  if (typeof value !== "string") return "请输入文字内容。";
  const prompt = value.trim();
  if (!prompt) return "请输入你想咨询的内容。";
  if (prompt.length > 4000) return "内容太长了，请分段发送。";
  return null;
}

export function normalizeSessionId(value) {
  if (typeof value !== "string" || !value) return null;
  const sessionId = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  return sessionId;
}

export function buildBailianPayload(prompt, sessionId) {
  const input = { prompt: String(prompt).trim() };
  if (sessionId) input.session_id = sessionId;
  return { input, parameters: {}, debug: {} };
}

export function extractBailianReply(payload) {
  const text = payload?.output?.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("百炼返回了空回复。");
  }
  return {
    text: text.trim(),
    sessionId: payload?.output?.session_id || null,
  };
}

export function describeUpstreamError(status, payload) {
  const detail = payload?.message || payload?.code || payload?.error?.message;
  if (status === 401 || status === 403) return "服务端密钥或应用权限无效，请检查部署配置。";
  if (status === 404) return "找不到这个应用，请检查 APP ID 和地域配置。";
  if (status === 429) return "当前咨询人数较多，请稍后再试。";
  return detail ? `百炼服务暂时不可用：${detail}` : "百炼服务暂时不可用，请稍后再试。";
}
