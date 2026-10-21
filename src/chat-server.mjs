import {
  buildBailianPayload,
  describeUpstreamError,
  extractBailianReply,
  normalizeSessionId,
  validateChatInput,
} from "./chat-core.mjs";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com";

export async function callBailian({ prompt, sessionId, env = process.env, fetchImpl = fetch }) {
  const validationError = validateChatInput(prompt);
  if (validationError) return { status: 400, body: { error: validationError } };
  const safeSessionId = normalizeSessionId(sessionId);

  const apiKey = env.DASHSCOPE_API_KEY;
  const appId = env.DASHSCOPE_APP_ID;
  const managedAgentId = env.MANAGED_AGENT_ID || (appId?.startsWith("agent_") ? appId : null);
  if (managedAgentId) {
    if (!apiKey || !env.MANAGED_AGENT_ENVIRONMENT_ID) {
      return { status: 503, body: { error: "服务端尚未配置托管 Agent 的密钥或运行环境。" } };
    }
    const { callManagedAgent } = await import("./managed-agent.mjs");
    const configuredTimeout = Number(env.MANAGED_AGENT_TIMEOUT_MS);
    return callManagedAgent({
      prompt: prompt.trim(),
      sessionId: safeSessionId,
      apiKey,
      agentId: managedAgentId,
      environmentId: env.MANAGED_AGENT_ENVIRONMENT_ID,
      baseUrl: env.MANAGED_AGENT_BASE_URL || "https://maas.qianwenaiapi.com/api/v1/agentstudio",
      timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(configuredTimeout, 110_000) : 90_000,
      fetchImpl,
    });
  }
  if (!apiKey || !appId) {
    return {
      status: 503,
      body: { error: "服务端还没有配置百炼密钥或 APP ID。" },
    };
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (env.DASHSCOPE_WORKSPACE_ID) {
    headers["X-DashScope-WorkSpace"] = env.DASHSCOPE_WORKSPACE_ID;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  let response;
  try {
    response = await fetchImpl(
      `${(env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/api/v1/apps/${encodeURIComponent(appId)}/completion`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(buildBailianPayload(prompt, safeSessionId)),
        signal: controller.signal,
      },
    );
  } catch {
    return { status: 502, body: { error: "暂时无法连接百炼服务，请稍后再试。" } };
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { status: response.status >= 500 ? 502 : response.status, body: { error: describeUpstreamError(response.status, {}) } };
  }

  try {
    const reply = extractBailianReply(payload);
    return { status: 200, body: reply };
  } catch (error) {
    return { status: 502, body: { error: error.message } };
  }
}
