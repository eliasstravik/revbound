"use client";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { openConversationInputs, useEveAgent, type EveMessage, type EveMessagePart } from "eve/react";
import { Markdown } from "revbound/ui";
import "./chat.css";

const SAVED = "revbound-chat-session";

const read = () => { try { return localStorage.getItem(SAVED) ?? undefined; } catch { return undefined; } };
const save = (id: string | undefined) => { try { if (id) localStorage.setItem(SAVED, id); else localStorage.removeItem(SAVED); } catch {} };

/** What a failed request means for the person, with its fix. */
function problem(error: Error | undefined): string | undefined {
  if (!error) return undefined;
  const text = error.message ?? String(error);
  if (/40[13]/.test(text) && /Authentication/.test(text)) return "Turn on Vercel Authentication → All Deployments to use the chat.";
  if (/session_(not_active|expired|stranded)/.test(text)) return "This conversation has ended. Start a new chat.";
  if (/fetch|network|50[234]|ECONNREFUSED/i.test(text)) return "The agent is not answering. On your computer, keep `npm run dev` running; deployed, redeploy and try again.";
  return text;
}

/** A step's label on one short line. */
const short = (label: string) => {
  const line = label.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
};

function Part({ part, user }: { part: EveMessagePart; user: boolean }) {
  if (part.type === "text") return !part.text.trim() ? null : user ? <p>{part.text}</p> : <Markdown source={part.text} />;
  if (part.type === "dynamic-tool") {
    const label = short(part.toolMetadata?.eve?.label ?? part.toolName.replace(/[_-]+/g, " "));
    const state = "state" in part ? part.state : undefined;
    const failed = state === "output-error" || state === "output-denied";
    return <p className={`chat-step${failed ? " failed" : ""}`}>{label}{failed ? " (stopped)" : ""}</p>;
  }
  if (part.type === "authorization" && part.state !== "completed") {
    return <p className="chat-step">{part.description} {part.authorization?.url && <a href={part.authorization.url} target="_blank" rel="noreferrer">Sign in ↗</a>}</p>;
  }
  return null;
}

function Message({ message }: { message: EveMessage }) {
  const failed = message.metadata?.status === "failed";
  return (
    <div className={`chat-msg ${message.role}${failed ? " failed" : ""}`}>
      {message.parts.map((part, i) => <Part key={("id" in part && part.id) || i} part={part} user={message.role === "user"} />)}
      {failed && <p className="chat-step failed">Not sent.</p>}
    </div>
  );
}

/** One conversation: messages, the asks waiting on this person (approvals, questions) and the composer. */
function Conversation({ sessionId, onSession, onNew }: { sessionId?: string; onSession: (id: string | undefined) => void; onNew: () => void }) {
  const base = process.env.__NEXT_ROUTER_BASEPATH ?? "";
  const agent = useEveAgent({
    host: typeof location === "undefined" ? base : `${location.origin}${base}`,
    ...(sessionId && { initialSession: { sessionId, streamIndex: 0 }, resume: true }),
    onSessionChange: (s) => onSession(s?.sessionId),
  });
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const asks = openConversationInputs(agent.data);
  const messages = agent.data.messages;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [agent.events.length, messages.length, asks.length]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || agent.status === "resuming") return;
    setDraft("");
    void agent.send(text, busy ? { turnPolicy: "steer" } : undefined).catch(() => undefined);
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e as unknown as FormEvent);
  };
  const error = problem(agent.error);

  return (
    <>
      <div className="title-row">
        <h1>Chat</h1>
        <button type="button" onClick={onNew} disabled={!messages.length && !sessionId}>New chat</button>
      </div>
      <div className="chat">
        <div className="chat-log" aria-live="polite">
          {!messages.length && agent.status !== "resuming" && (
            <div className="chat-empty">
              <p>Ask about the company, its workflows and runs.</p>
              <p>The agent can change a workflow and start a run after your yes.</p>
            </div>
          )}
          {messages.map((m) => <Message key={m.id} message={m} />)}
          {asks.map(({ request }) => (
            <fieldset key={request.requestId} className="chat-ask" disabled={agent.status === "resuming"}>
              <legend>{request.kind === "tool-approval" ? "Your yes is needed" : "A question for you"}</legend>
              <p>{request.prompt}</p>
              <div className="chat-ask-options">
                {request.options?.map((o) => (
                  <button key={o.id} type="button" className={o.style === "primary" || o.id === "approve" ? "primary" : undefined}
                    onClick={() => void agent.respond([{ requestId: request.requestId, optionId: o.id }]).catch(() => undefined)}>{o.label}</button>
                ))}
              </div>
              {request.kind !== "tool-approval" && (request.allowFreeform === true || !request.options?.length) && (
                <form className="chat-answer" onSubmit={(e) => {
                  e.preventDefault();
                  const text = String(new FormData(e.currentTarget).get("answer") ?? "").trim();
                  if (text) void agent.respond([{ requestId: request.requestId, text }]).catch(() => undefined);
                }}>
                  <input name="answer" aria-label="Answer" placeholder="Your answer" autoComplete="off" />
                  <button type="submit" className="primary">Answer</button>
                </form>
              )}
            </fieldset>
          ))}
          {busy && !asks.length && <p className="chat-step working">Working…</p>}
          {error && <p className="notice">{error}</p>}
          <div ref={end} />
        </div>
        <form className="chat-compose" onSubmit={send}>
          <textarea name="message" rows={2} value={draft} placeholder="Message the agent" aria-label="Message"
            onChange={(e) => setDraft(e.target.value)} onKeyDown={keys} disabled={agent.status === "resuming"} />
          {busy ? <button type="button" onClick={() => void agent.cancel().catch(() => undefined)}>Stop</button>
            : <button type="submit" className="primary" disabled={!draft.trim() || agent.status === "resuming"}>Send</button>}
        </form>
      </div>
    </>
  );
}

/** Chat: the console's conversation with the project's agent. The current conversation comes back after a reload. */
export default function ChatView() {
  const [state, setState] = useState<{ key: number; session?: string } | null>(null);
  useEffect(() => setState({ key: 0, session: read() }), []);
  if (!state) return null;
  return (
    <Conversation key={state.key} sessionId={state.session}
      onSession={(id) => save(id)}
      onNew={() => { save(undefined); setState({ key: state.key + 1 }); }} />
  );
}
