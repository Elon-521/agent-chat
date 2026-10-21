const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_PROMPT_LENGTH = 4000;
const SAFE_ERRORS = {
  config: "服务端托管 Agent 配置不完整。",
  invalid: "请输入有效的咨询内容。",
  connection: "暂时无法连接问诊服务，请稍后再试。",
  upstream: "问诊服务暂时不可用，请稍后再试。",
  timeout: "问诊服务响应超时，请稍后再试。",
  malformed: "问诊服务返回了无法识别的结果，请稍后再试。",
  session: "会话无效，请重新开始咨询。",
  approval: "该请求需要在百炼后台完成工具审批，请处理后重试。",
  runtime: "问诊服务暂时无法完成这次请求，请稍后重试。",
};

function safeId(value, prefix) {
  if (typeof value !== "string" || !value || value.length > 128) return null;
  const id = value.trim();
  return id.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

function validateConfig({ apiKey, agentId, environmentId, baseUrl }) {
  if (typeof apiKey !== "string" || !apiKey.trim()) return false;
  if (!safeId(agentId, "agent_")) return false;
  if (!safeId(environmentId, "env_")) return false;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function jsonHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function safeHttpStatus(status) {
  return status >= 500 ? 502 : 502;
}

function readTextBlock(message) {
  if (!message || message.role !== "assistant" || message.type !== "message") return "";
  return (message.content || [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function readRefusalBlock(message) {
  if (!message || message.role !== "assistant" || message.type !== "message") return "";
  return (message.content || [])
    .filter((block) => block?.type === "refusal" && typeof block.refusal === "string")
    .map((block) => block.refusal)
    .join("")
    .trim();
}

function readStatus(message) {
  if (message?.type !== "session_status") return null;
  const data = message.content?.find((block) => block?.type === "data")?.data;
  if (!data || typeof data.session_status !== "string") return null;
  return { status: data.session_status, stopReason: data.stop_reason || null };
}

function abortError() {
  const error = new Error("operation timed out");
  error.code = "TIMEOUT";
  return error;
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readJson(response, signal) {
  return withAbort(response.json(), signal);
}

async function fetchWithTimeout(fetchImpl, url, options, signal) {
  return withAbort(fetchImpl(url, options), signal);
}

class SseReader {
  constructor(response, signal) {
    this.reader = response.body?.getReader?.();
    if (!this.reader) throw new Error("missing stream");
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.eventName = "message";
    this.dataLines = [];
    this.pending = [];
    this.signal = signal;
    this.connected = false;
  }

  consumeLine(line) {
    if (line.startsWith(":")) {
      if (line.trim() === ":connected" || line.trim() === ": connected") this.connected = true;
      return;
    }
    if (!line) {
      if (this.dataLines.length) {
        const raw = this.dataLines.join("\n");
        try {
          this.pending.push({ event: this.eventName || "message", data: JSON.parse(raw) });
        } catch {
          this.pending.push({ event: this.eventName || "message", data: null });
        }
      }
      this.eventName = "message";
      this.dataLines = [];
      return;
    }
    if (line.startsWith("event:")) {
      this.eventName = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }

  consumeText(text) {
    this.buffer += text;
    const lines = this.buffer.split(/\r\n|\n|\r/);
    this.buffer = lines.pop() || "";
    for (const line of lines) this.consumeLine(line);
  }

  async readChunk() {
    const result = await withAbort(this.reader.read(), this.signal);
    if (result.done) {
      const tail = this.decoder.decode();
      if (tail) this.consumeText(tail);
      if (this.buffer) this.consumeLine(this.buffer);
      this.consumeLine("");
      return false;
    }
    this.consumeText(this.decoder.decode(result.value, { stream: true }));
    return true;
  }

  async waitForConnected() {
    while (!this.connected) {
      if (!(await this.readChunk())) throw new Error("stream closed before connected");
    }
  }

  async next() {
    while (!this.pending.length) {
      if (!(await this.readChunk())) return null;
    }
    return this.pending.shift();
  }

  discardBufferedEvents() {
    this.pending = [];
    this.buffer = "";
    this.eventName = "message";
    this.dataLines = [];
  }

  async close() {
    try {
      await this.reader.cancel();
    } catch {
      // The stream may already have closed.
    }
  }
}

function result(status, error, sessionId) {
  const body = { error };
  if (sessionId) body.sessionId = sessionId;
  return { status, body };
}

export async function callManagedAgent({
  prompt,
  sessionId,
  apiKey,
  agentId,
  environmentId,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!trimmedPrompt || trimmedPrompt.length > MAX_PROMPT_LENGTH) return result(400, SAFE_ERRORS.invalid);
  if (!validateConfig({ apiKey, agentId, environmentId, baseUrl })) return result(503, SAFE_ERRORS.config);
  const requestedSessionId = sessionId ? safeId(sessionId, "sesn_") : null;
  if (sessionId && !requestedSessionId) return result(400, SAFE_ERRORS.session);

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = controller.signal;
  const headers = jsonHeaders(apiKey.trim());
  let activeSessionId = requestedSessionId;
  let stream;
  try {
    if (activeSessionId) {
      const response = await fetchWithTimeout(fetchImpl, endpoint(baseUrl, `/sessions/${encodeURIComponent(activeSessionId)}`), {
        method: "GET",
        headers,
        signal,
      }, signal);
      if (!response.ok) return result(safeHttpStatus(response.status), SAFE_ERRORS.session, activeSessionId);
      const session = await readJson(response, signal);
      if (session?.agent?.id !== agentId || (session.environment_id && session.environment_id !== environmentId)) {
        return result(400, SAFE_ERRORS.session, activeSessionId);
      }
    } else {
      const response = await fetchWithTimeout(fetchImpl, endpoint(baseUrl, "/sessions"), {
        method: "POST",
        headers,
        body: JSON.stringify({ agent: { type: "agent", id: agentId }, environment_id: environmentId }),
        signal,
      }, signal);
      if (!response.ok) return result(safeHttpStatus(response.status), SAFE_ERRORS.upstream);
      const session = await readJson(response, signal);
      activeSessionId = safeId(session?.id, "sesn_");
      if (!activeSessionId) return result(502, SAFE_ERRORS.malformed);
    }

    const sseResponse = await fetchWithTimeout(fetchImpl, endpoint(baseUrl, `/sessions/${encodeURIComponent(activeSessionId)}/events/stream`), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "text/event-stream" },
      signal,
    }, signal);
    if (!sseResponse.ok) return result(safeHttpStatus(sseResponse.status), SAFE_ERRORS.connection, activeSessionId);
    stream = new SseReader(sseResponse, signal);
    await stream.waitForConnected();
    // The stream may replay prior events immediately after connecting. Only frames
    // emitted after this request is enqueued belong to the turn being answered.
    stream.discardBufferedEvents();

    const eventResponse = await fetchWithTimeout(fetchImpl, endpoint(baseUrl, `/sessions/${encodeURIComponent(activeSessionId)}/events`), {
      method: "POST",
      headers,
      body: JSON.stringify({ input: [{ role: "user", type: "message", content: [{ type: "text", text: trimmedPrompt }] }] }),
      signal,
    }, signal);
    if (!eventResponse.ok) return result(safeHttpStatus(eventResponse.status), SAFE_ERRORS.upstream, activeSessionId);
    await readJson(eventResponse, signal);

    let running = false;
    const messages = [];
    const seenIds = new Set();
    while (true) {
      const frame = await stream.next();
      if (!frame) return result(502, SAFE_ERRORS.connection, activeSessionId);
      const message = frame.data;
      if (!message || (message.id && seenIds.has(message.id))) continue;
      if (message.id) seenIds.add(message.id);
      if (message.type === "error") return result(502, SAFE_ERRORS.runtime, activeSessionId);
      const state = readStatus(message);
      if (state?.status === "running") {
        running = true;
        continue;
      }
      if (!running) continue;
      if (message.type === "message" && message.role === "assistant") {
        const text = readTextBlock(message) || readRefusalBlock(message);
        if (text) messages.push(text);
        continue;
      }
      if (state?.status === "idle") {
        if (state.stopReason?.type === "requires_action") return result(409, SAFE_ERRORS.approval, activeSessionId);
        if (state.stopReason?.type === "retries_exhausted") return result(502, SAFE_ERRORS.runtime, activeSessionId);
        if (state.stopReason?.type === "end_turn") {
          const text = messages.join("\n").trim();
          return text ? { status: 200, body: { text, sessionId: activeSessionId } } : result(502, SAFE_ERRORS.malformed, activeSessionId);
        }
      }
      if (state?.status === "terminated") return result(502, SAFE_ERRORS.runtime, activeSessionId);
    }
  } catch (error) {
    if (error?.code === "TIMEOUT" || signal.aborted) return result(504, SAFE_ERRORS.timeout, activeSessionId);
    if (error?.message === "stream closed before connected" || error?.message === "missing stream") return result(502, SAFE_ERRORS.connection, activeSessionId);
    if (error instanceof SyntaxError) return result(502, SAFE_ERRORS.malformed, activeSessionId);
    return result(502, SAFE_ERRORS.connection, activeSessionId);
  } finally {
    clearTimeout(timer);
    if (stream) await stream.close();
  }
}
