import { useMemo, useRef, useState } from "react";
import { validateChatInput } from "./chat-core.mjs";

const API_ENDPOINT = import.meta.env.VITE_API_BASE_URL || "/api/chat";

const welcomeMessages = [
  {
    id: "welcome",
    role: "assistant",
    text: "我会先了解你的情况，再帮你整理可能的原因和下一步建议。",
  },
];

function messageId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

export function App() {
  const [messages, setMessages] = useState(welcomeMessages);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef(null);

  const hasConversation = useMemo(() => messages.length > 1, [messages.length]);

  function resetConversation() {
    setMessages(welcomeMessages);
    setSessionId(null);
    setDraft("");
    setError("");
    textareaRef.current?.focus();
  }

  async function submitMessage(event) {
    event?.preventDefault();
    const validationError = validateChatInput(draft);
    if (validationError || isSending) {
      if (validationError) setError(validationError);
      return;
    }

    const prompt = draft.trim();
    setDraft("");
    setError("");
    setMessages((current) => [...current, { id: messageId(), role: "user", text: prompt }]);
    setIsSending(true);

    try {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, sessionId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (payload.sessionId) setSessionId(payload.sessionId);
      if (!response.ok) throw new Error(payload.error || "暂时无法取得回复，请稍后再试。");
      setMessages((current) => [...current, { id: messageId(), role: "assistant", text: payload.text }]);
      setSessionId(payload.sessionId || sessionId);
    } catch (requestError) {
      setError(requestError.message || "暂时无法取得回复，请稍后再试。");
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage(event);
    }
  }

  return (
    <main className="page-shell">
      <section className="chat-panel" aria-label="问诊大师聊天窗口">
        <header className="chat-header">
          <div className="brand-mark" aria-hidden="true">问</div>
          <div className="brand-copy">
            <h1>问诊大师</h1>
            <p><span className="online-dot" />陪伴感更强的问诊记录</p>
          </div>
          <button className="reset-button" type="button" onClick={resetConversation} disabled={!hasConversation && !draft}>
            重新开始
          </button>
        </header>

        <div className="intro-block">
          <h2>慢慢说，我在听</h2>
          <p>从最困扰你的症状开始，不必一次说完。</p>
        </div>

        <div className="message-list" aria-live="polite">
          {messages.map((message) => (
            <article className={`message-row ${message.role}`} key={message.id}>
              <div className="message-bubble">
                {message.role === "assistant" && <div className="message-author">问诊大师</div>}
                <p>{message.text}</p>
              </div>
            </article>
          ))}
          {isSending && (
            <article className="message-row assistant">
              <div className="message-bubble typing-bubble" aria-label="正在回复">
                <div className="message-author">问诊大师</div>
                <div className="typing-indicator"><span /><span /><span /></div>
              </div>
            </article>
          )}
        </div>

        <form className="composer" onSubmit={submitMessage}>
          <label className="sr-only" htmlFor="message-input">输入你的症状</label>
          <textarea
            ref={textareaRef}
            id="message-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入你的症状…"
            rows="1"
            maxLength={4000}
            disabled={isSending}
          />
          <button className="send-button" type="submit" disabled={isSending || !draft.trim()}>
            {isSending ? "发送中" : "发送"}
          </button>
        </form>
        <div className="composer-meta">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <span>{draft.length}/4000</span>
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <p className="disclaimer">仅供健康信息参考，不能替代医生面诊。若有紧急不适，请及时联系当地急救或医疗机构。</p>
      </section>
    </main>
  );
}
