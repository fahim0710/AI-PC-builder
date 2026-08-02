import { type FormEvent, useEffect, useState } from "react";
import { auth } from "./firebase";

type BuildProduct = { id: string; name: string; category: string; price: number; description: string; specifications: string[]; imageUrl: string; sourceUrl: string; reason: string };
type ChatMessage = { id?: string; role: "user" | "assistant"; content: string; build?: BuildProduct[]; sources?: Array<{ title: string; url?: string }>; guardrails?: { passed: boolean; warnings: string[] } };
type Conversation = { id: string; title: string; preview?: string };

const inlineMarkdown = (text: string) => text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
function StructuredAnswer({ content }: { content: string }) {
  return <div className="ai-answer">{content.split("\n").map((line, index) => {
    if (line.startsWith("## ")) return <h4 key={index}>{inlineMarkdown(line.slice(3))}</h4>;
    if (/^[-*]\s/.test(line)) return <div className="ai-answer-bullet" key={index}><span>•</span><p>{inlineMarkdown(line.replace(/^[-*]\s/, ""))}</p></div>;
    if (!line.trim()) return <div className="ai-answer-space" key={index} />;
    return <p key={index}>{inlineMarkdown(line)}</p>;
  })}</div>;
}

async function aiFetch(url: string, options: RequestInit = {}) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Please sign in again.");
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "AI request failed.");
  return body;
}

export function AiChat({ authenticated, guestSessionId, guestUsed, onGuestUsed, onRequireLogin, onClose, onApplyBuild }: {
  authenticated: boolean; guestSessionId: string; guestUsed: boolean; onGuestUsed: () => void; onRequireLogin: () => void;
  onClose: () => void; onApplyBuild: (build: BuildProduct[]) => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadConversations = async () => {
    try { const data = await aiFetch("/api/ai/conversations"); setConversations(data.conversations); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load conversations."); }
  };
  useEffect(() => { if (authenticated) void loadConversations(); }, [authenticated]);

  const openConversation = async (id: string) => {
    setConversationId(id); setBusy(true); setError("");
    try { const data = await aiFetch(`/api/ai/conversations/${id}/messages`); setMessages(data.messages); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load chat."); }
    finally { setBusy(false); }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!authenticated && guestUsed) { onRequireLogin(); return; }
    const question = input.trim(); if (!question || busy) return;
    setInput(""); setError(""); setBusy(true); setMessages((current) => [...current, { role: "user", content: question }]);
    try {
      if (authenticated) {
        const data = await aiFetch("/api/ai/chat", { method: "POST", body: JSON.stringify({ conversationId, message: question }) });
        setConversationId(data.conversationId); setMessages((current) => [...current, data.message]); void loadConversations();
      } else {
        const response = await fetch("/api/ai/guest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: guestSessionId, message: question }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Guest AI request failed.");
        setMessages((current) => [...current, data.message]); onGuestUsed();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "AI request failed."); }
    finally { setBusy(false); }
  };

  const deleteConversation = async (id: string) => {
    if (!window.confirm("Delete this chat and all of its messages permanently?")) return;
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch(`/api/ai/conversations/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("Could not delete chat.");
      setConversations((current) => current.filter((conversation) => conversation.id !== id));
      if (conversationId === id) { setConversationId(undefined); setMessages([]); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete chat."); }
  };

  return <div className="modal-backdrop ai-backdrop" onMouseDown={onClose}><section className="ai-chat" role="dialog" aria-modal="true" aria-label="Nexa PC builder" onMouseDown={(e) => e.stopPropagation()}>
    <aside className="ai-history"><div><span className="brand-mark">N</span><b>NEXA</b></div>{authenticated ? <><button onClick={() => { setConversationId(undefined); setMessages([]); }}>+ New build chat</button><nav>{conversations.map((conversation) => <div className={`ai-conversation-row ${conversation.id === conversationId ? "active" : ""}`} key={conversation.id}><button onClick={() => void openConversation(conversation.id)}><b>{conversation.title}</b><small>{conversation.preview}</small></button><button className="ai-delete-chat" aria-label={`Delete ${conversation.title}`} onClick={() => void deleteConversation(conversation.id)}>×</button></div>)}</nav></> : <div className="guest-note"><b>Guest mode</b><span>One prompt per page load. Sign in for history and follow-ups.</span><button onClick={onRequireLogin}>Sign in</button></div>}</aside>
    <div className="ai-main"><header><div><div className="step">MEET NEXA</div><h2>Build your PC with Nexa</h2></div><button aria-label="Close" onClick={onClose}>×</button></header>
      <div className="ai-messages">{messages.length === 0 && <><article className="ai-message assistant nexa-welcome"><div className="ai-role">NEXA</div><StructuredAnswer content="Hi! I’m Nexa, your PC-building assistant. Tell me your budget and what you want to do with your PC, and I’ll help you choose a complete build." /></article><div className="ai-empty"><span>✦</span><h3>What do you want to build?</h3><p>Include your budget, games or software, resolution and target FPS.</p><button onClick={() => setInput("Build me a GTA V gaming PC under ৳100,000 for 1080p 60 FPS")}>Try a GTA V build</button></div></>}
        {messages.map((message, index) => <article className={`ai-message ${message.role}`} key={`${message.role}-${message.id ?? `local-${index}`}`}><div className="ai-role">{message.role === "user" ? "YOU" : "NEXA"}</div><StructuredAnswer content={message.content} />
          {message.build && message.build.length > 0 && <div className="ai-build"><header><b>{new Set(message.build.map((product) => product.category.toLowerCase())).size > 1 ? "VALIDATED DATABASE BUILD" : "DATABASE MATCHES"}</b><button onClick={() => onApplyBuild(message.build!)}>Apply selection</button></header>{message.build.map((product) => <div key={product.id}><span>{product.category}</span><strong>{product.name}</strong><b>৳{product.price.toLocaleString("en-BD")}</b></div>)}</div>}
          {message.sources && message.sources.length > 0 && <details><summary>Sources used ({message.sources.length})</summary>{message.sources.map((source, sourceIndex) => source.url ? <a key={sourceIndex} href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : <span key={sourceIndex}>{source.title}</span>)}</details>}
          {message.guardrails?.warnings?.length ? <details className="ai-warnings"><summary>Compatibility warnings</summary>{message.guardrails.warnings.map((warning) => <span key={warning}>{warning}</span>)}</details> : null}
        </article>)}{!authenticated && guestUsed && <div className="guest-login-callout"><b>Want to ask another question?</b><span>Sign in to continue this conversation and save your history.</span><button onClick={onRequireLogin}>Sign in to continue</button></div>}{busy && <div className="ai-thinking">Loading…</div>}{error && <p className="ai-error">{error}</p>}</div>
      <form className="ai-composer" onSubmit={send}><textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder={!authenticated && guestUsed ? "Sign in to continue chatting" : "Example: Best GTA V PC under ৳100,000 for 1080p?"} maxLength={2000} /><button disabled={busy || (!input.trim() && !(guestUsed && !authenticated))}>{!authenticated && guestUsed ? "Sign in" : "Send"} <span>↑</span></button></form>
    </div>
  </section></div>;
}
