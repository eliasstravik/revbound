"use client";
import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { openConversationInputs, useEveAgent, type EveDynamicToolPart, type EveMessage, type EveMessagePart } from "eve/react";
import { Markdown } from "revbound/ui";
import { call, listen, meter, voiceError, voiceReady, type CallHandle, type CallState, type Listening } from "./speech.js";
import "./chat.css";

const SAVED = "revbound-chat-session", MODE = "revbound-chat-mode";
/** What one message may carry in files, as sent: the platform's request limit with room for the text. */
const MAX_BYTES = 3_000_000;
const ASK_ONLY = "Ask mode: answer only. Change no files and start no runs in this turn; say what you would change instead.";

const read = (key: string) => { try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; } };
const save = (key: string, v: string | undefined) => { try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } catch {} };

/** What a failed request means for the person, with its fix. */
function problem(error: Error | undefined): string | undefined {
  if (!error) return undefined;
  const text = error.message ?? String(error);
  if (/40[13]/.test(text) && /Authentication/.test(text)) return "Turn on Vercel Authentication → All Deployments to use the chat.";
  if (/session_(not_active|expired|stranded)/.test(text)) return "This conversation has ended. Start a new chat.";
  if (/413/.test(text)) return "Those files are too big to send. Send fewer or smaller ones.";
  if (/fetch|network|50[0234]|Internal Server Error|ECONNREFUSED/i.test(text)) return "The agent is not answering. On your computer, keep `npm run dev` running; deployed, redeploy and try again.";
  return text;
}

// ---------------------------------------------------------------- icons (16px, stroked like the console's)

const PATHS = {
  plus: "M8 3v10M3 8h10", mic: "M6 4a2 2 0 0 1 4 0v3.5a2 2 0 0 1-4 0zM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2",
  micOff: "M6 4a2 2 0 0 1 4 0v3.5a2 2 0 0 1-4 0zM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2M2.5 2.5l11 11", wave: "M2 7v2M5 5v6M8 2.5v11M11 5v6M14 7v2",
  up: "M8 13V3M4 7l4-4 4 4", x: "M4 4l8 8M12 4l-8 8", check: "M3.5 8.5l3 3 6-7", right: "M6 4l4 4-4 4", down: "M4 6l4 4 4-4",
  file: "M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-9zM9.5 1.5v3h3",
  camera: "M2 5.5h2.5l1.5-2h4l1.5 2H14V13H2zM8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4", end: "M2 9.5c3.5-3 8.5-3 12 0l-1.5 2-2.5-.8V9a6 6 0 0 0-4 0v1.7l-2.5.8z",
};
const Ic = ({ name }: { name: keyof typeof PATHS | "stop" }) => (
  <svg className="chat-ic" viewBox="0 0 16 16" aria-hidden="true">
    {name === "stop" ? <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" /> : <path d={PATHS[name]} />}
  </svg>
);

/** The live wave: bars that follow `level` (0..1) each frame, or move on their own while `auto`. */
function Wave({ level, auto, quiet }: { level?: () => number; auto?: boolean; quiet?: boolean }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!level || quiet) return;
    let frame = 0;
    const tick = () => { el.current?.style.setProperty("--level", level().toFixed(3)); frame = requestAnimationFrame(tick); };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [level, quiet]);
  return (
    <span ref={el} className={`chat-wave${auto && !quiet ? " auto" : ""}${quiet ? " quiet" : ""}`} aria-hidden="true">
      {Array.from({ length: 40 }, (_, i) => <i key={i} style={{ "--h": `${30 + ((i * 53) % 70)}%`, "--d": `${-((i * 137) % 900)}ms` } as CSSProperties} />)}
    </span>
  );
}

function useClock(on: boolean) {
  const [s, set] = useState(0);
  useEffect(() => { if (!on) return; set(0); const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, [on]);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- messages

type Attachment = { id: string; file: File; url?: string };
const isImage = (type: string) => /^image\/(png|jpe?g|gif|webp)$/.test(type);
const size = (n?: number) => (n == null ? "" : n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(1)} MB`);

function Chip({ name, type, bytes, url, onRemove }: { name: string; type: string; bytes?: number; url?: string; onRemove?: () => void }) {
  const photo = url && isImage(type);
  return (
    <span className={photo ? "chat-att photo" : "chat-att"} title={name}>
      {photo ? <img src={url} alt={name} /> : <><span className="chat-att-icon"><Ic name="file" /></span><span className="chat-att-name">{name}<small>{size(bytes)}</small></span></>}
      {onRemove && <button type="button" className="chat-att-remove" aria-label={`Remove ${name}`} onClick={onRemove}><Ic name="x" /></button>}
    </span>
  );
}

/** A step's label on one short line. */
const label = (p: EveDynamicToolPart) => {
  const line = (p.toolMetadata?.eve?.label ?? p.toolName.replace(/[_-]+/g, " ")).replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
};
const failed = (p: EveDynamicToolPart) => p.state === "output-error" || p.state === "output-denied";
const running = (p: EveDynamicToolPart) => !p.state.startsWith("output-");

/** A run of tool calls: one line that opens to every step. */
function Steps({ parts, live }: { parts: EveDynamicToolPart[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const now = live ? parts.findLast(running) : undefined, stopped = parts.filter(failed).length;
  return (
    <div className="chat-steps">
      <button type="button" className="chat-steps-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Ic name={open ? "down" : "right"} />
        {now ? <span className="chat-shimmer">{label(now)}</span> : <span>{parts.length === 1 ? label(parts[0]) : `${parts.length} steps`}</span>}
        {stopped > 0 && <span className="chat-failed">· {stopped} stopped</span>}
      </button>
      {open && <ul role="list">{parts.map((p) => <li key={p.toolCallId} className={failed(p) ? "chat-failed" : undefined}>{label(p)}{failed(p) ? " (stopped)" : ""}</li>)}</ul>}
    </div>
  );
}

function Message({ message, live, spoken }: { message: EveMessage; live: boolean; spoken: boolean }) {
  const user = message.role === "user", out: ReactNode[] = [];
  let tools: EveDynamicToolPart[] = [];
  const flush = (key: number) => { if (tools.length) out.push(<Steps key={`s${key}`} parts={tools} live={live} />); tools = []; };
  const files = message.parts.filter((p): p is Extract<EveMessagePart, { type: "file" }> => p.type === "file");
  message.parts.forEach((part, i) => {
    if (part.type === "dynamic-tool") { tools.push(part); return; }
    // Steps stay one group across step boundaries and empty text between them.
    if (part.type === "step-start" || part.type === "reasoning" || (part.type === "text" && !part.text.trim())) return;
    flush(i);
    if (part.type === "text" && part.text.trim()) out.push(user ? <div key={i} className="chat-bubble">{part.text}</div> : <Markdown key={i} source={part.text} />);
    if (part.type === "authorization" && part.state !== "completed") {
      out.push(<p key={i} className="chat-status">{part.description} {part.authorization?.url && <a href={part.authorization.url} target="_blank" rel="noreferrer">Sign in ↗</a>}</p>);
    }
  });
  flush(message.parts.length);
  const failedSend = message.metadata?.status === "failed";
  return (
    <div className={`chat-msg ${message.role}${failedSend ? " failed" : ""}`}>
      {files.length > 0 && <div className="chat-atts">{files.map((f, i) => <Chip key={i} name={f.filename ?? "File"} type={f.mediaType} bytes={f.size} url={f.url} />)}</div>}
      {spoken && <span className="chat-said"><Ic name="wave" />{user ? "You said" : "Spoken"}</span>}
      {out}
      {failedSend && <p className="chat-status failed">Not sent.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- files

/** A picture made smaller (2000px at most, JPEG) when it is big; anything else as it is. */
async function shrink(file: File): Promise<Blob> {
  if (!isImage(file.type) || file.type === "image/gif" || file.size < 1_000_000) return file;
  const img = await createImageBitmap(file), scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((done) => canvas.toBlob((b) => done(b ?? file), "image/jpeg", 0.85));
}
const dataUrl = (blob: Blob) => new Promise<string>((done, fail) => {
  const r = new FileReader();
  r.onload = () => done(String(r.result));
  r.onerror = () => fail(r.error);
  r.readAsDataURL(blob);
});

/** One frame of a screen, window or tab the person picks. */
async function screenshot(): Promise<File> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  try {
    const video = Object.assign(document.createElement("video"), { srcObject: stream, muted: true });
    await video.play();
    const canvas = Object.assign(document.createElement("canvas"), { width: video.videoWidth, height: video.videoHeight });
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    return new File([blob!], "Screenshot.png", { type: "image/png" });
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// ---------------------------------------------------------------- the conversation

type Voice = { kind: "listen"; handle?: Listening; writing?: boolean } | { kind: "call"; handle?: CallHandle; state?: CallState; muted: boolean };

/** One conversation: messages, the asks waiting on this person (approvals, questions) and the box. */
function Conversation({ sessionId, onSession, onNew }: { sessionId?: string; onSession: (id: string | undefined) => void; onNew: () => void }) {
  const base = process.env.__NEXT_ROUTER_BASEPATH ?? "";
  const host = typeof location === "undefined" ? base : `${location.origin}${base}`;
  const agent = useEveAgent({
    host,
    ...(sessionId && { initialSession: { sessionId, streamIndex: 0 }, resume: true }),
    onSessionChange: (s) => onSession(s?.sessionId),
  });
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [askOnly, setAskOnly] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [voice, setVoice] = useState<Voice>();
  const [said, setSaid] = useState<Set<string>>(() => new Set());
  const [drop, setDrop] = useState(false);
  const [mod, setMod] = useState("Ctrl");
  const log = useRef<HTMLDivElement>(null), box = useRef<HTMLTextAreaElement>(null), picker = useRef<HTMLInputElement>(null);
  const stick = useRef(true), voiceRef = useRef(voice), level = useRef<() => number>(undefined);
  voiceRef.current = voice;
  const busy = agent.status === "submitted" || agent.status === "streaming", resuming = agent.status === "resuming";
  const asks = openConversationInputs(agent.data), messages = agent.data.messages;
  const clock = useClock(Boolean(voice));
  useEffect(() => { setAskOnly(read(MODE) === "ask"); setMod(/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl"); }, []);
  useEffect(() => { if (stick.current) log.current?.scrollTo({ top: log.current.scrollHeight }); }, [agent.events.length, messages.length, asks.length]);
  useEffect(() => () => { const v = voiceRef.current; if (v?.kind === "listen") v.handle?.cancel(); if (v?.kind === "call") v.handle?.end(); }, []);

  // ---- sending
  const add = (list: FileList | File[] | null) => {
    const next = [...(list ?? [])].map((file) => ({ id: crypto.randomUUID(), file, url: isImage(file.type) ? URL.createObjectURL(file) : undefined }));
    if (next.length) setFiles((f) => [...f, ...next]);
  };
  const remove = (id: string) => setFiles((f) => f.filter((a) => { if (a.id === id && a.url) URL.revokeObjectURL(a.url); return a.id !== id; }));
  async function send(text: string, attached: Attachment[] = []) {
    const parts = await Promise.all(attached.map(async (a) => {
      const blob = await shrink(a.file);
      return { type: "file" as const, data: await dataUrl(blob), mediaType: blob.type || a.file.type || "application/octet-stream", filename: a.file.name };
    }));
    const bytes = parts.reduce((n, p) => n + p.data.length * 0.75, 0);
    if (bytes > MAX_BYTES) throw new Error(`Files can be up to ${size(MAX_BYTES)} in all in one message; these are ${size(bytes)}.`);
    const message = parts.length ? [...(text ? [{ type: "text" as const, text }] : []), ...parts] : text;
    await agent.send(message, { ...(busy && { turnPolicy: "steer" as const }), ...(askOnly && { clientContext: ASK_ONLY }) });
  }
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if ((!text && !files.length) || resuming) return;
    const attached = files;
    setDraft(""); setFiles([]); setNotice(undefined); stick.current = true;
    send(text, attached).then(() => attached.forEach((a) => a.url && URL.revokeObjectURL(a.url)), (err: Error) => {
      setDraft(text); setFiles(attached); setNotice(problem(err));
    });
  };

  // ---- the yes, from the keyboard
  const approval = asks.find(({ request }) => request.kind === "tool-approval")?.request;
  const yesOption = approval?.options?.find((o) => o.style === "primary" || o.id === "approve") ?? approval?.options?.[0];
  const noOption = approval?.options?.find((o) => o !== yesOption && (o.style === "danger" || /deny|reject|no/i.test(o.id))) ?? approval?.options?.find((o) => o !== yesOption);
  const respond = (requestId: string, optionId: string) => void agent.respond([{ requestId, optionId }]).catch((e: Error) => setNotice(problem(e)));
  useEffect(() => {
    const keys = (e: globalThis.KeyboardEvent) => {
      if (!approval || resuming) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && yesOption) { e.preventDefault(); respond(approval.requestId, yesOption.id); }
      else if (e.key === "Escape" && noOption && !voice && !(e.target instanceof HTMLTextAreaElement && e.target.value)) { e.preventDefault(); respond(approval.requestId, noOption.id); }
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  });

  // ---- talk to type
  async function startListening() {
    setMenu(false); setNotice(undefined); setVoice({ kind: "listen" });
    try {
      const no = await voiceReady(host);
      if (no) throw new Error(no);
      const handle = await listen(host);
      if (voiceRef.current?.kind !== "listen") return handle.cancel();
      const m = meter(handle.stream);
      level.current = m.level;
      setVoice((v) => (v?.kind === "listen" ? { ...v, handle: { ...handle, cancel: () => { m.stop(); handle.cancel(); }, finish: () => { m.stop(); return handle.finish(); } } } : v));
    } catch (e) { setNotice(voiceError(e)); setVoice(undefined); }
  }
  async function keepListening() {
    const v = voiceRef.current;
    if (v?.kind !== "listen" || !v.handle || v.writing) return;
    setVoice({ ...v, writing: true });
    try {
      const text = await v.handle.finish();
      if (text) setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
    } catch (e) { setNotice(voiceError(e)); }
    level.current = undefined;
    setVoice(undefined);
    box.current?.focus();
  }
  function stopVoice() {
    const v = voiceRef.current;
    if (v?.kind === "listen") v.handle?.cancel();
    if (v?.kind === "call") v.handle?.end();
    level.current = undefined;
    setVoice(undefined);
  }

  // ---- a voice call: what you ask goes to the agent as your message; its replies are read out
  const spokenFrom = useRef(0);
  async function startCall() {
    setNotice(undefined); setVoice({ kind: "call", muted: false });
    spokenFrom.current = messages.length;
    try {
      const handle = await call(host, {
        send: (text) => { setSaid((s) => new Set(s).add(text)); stick.current = true; void send(text).catch((e: Error) => setNotice(problem(e))); },
        onState: (state) => setVoice((v) => (v?.kind === "call" ? { ...v, state } : v)),
        onError: (m) => setNotice(m),
      });
      if (voiceRef.current?.kind !== "call") return handle.end();
      const m = meter(handle.stream);
      level.current = m.level;
      setVoice((v) => (v?.kind === "call" ? { ...v, handle: { ...handle, end: () => { m.stop(); handle.end(); } } } : v));
    } catch (e) { setNotice(voiceError(e)); setVoice(undefined); }
  }
  // When a turn settles during a call, the agent's reply (or the yes it waits for) is read out.
  const spoken = useRef(new Set<string>());
  useEffect(() => {
    if (voice?.kind !== "call" || !voice.handle) return;
    if (approval && !spoken.current.has(approval.requestId)) {
      spoken.current.add(approval.requestId);
      voice.handle.say(`It needs your yes in the chat: ${approval.prompt} Tap the button there to answer.`);
    }
    if (busy) return;
    const last = messages.slice(spokenFrom.current).findLast((m) => m.role === "assistant");
    if (!last || spoken.current.has(last.id)) return;
    const text = last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
    spoken.current.add(last.id);
    if (text) { voice.handle.say(text); setSaid((s) => new Set(s).add(last.id)); }
  }, [voice, busy, messages, approval]);

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) submit(e as unknown as FormEvent);
    else if (e.key === "Escape" && busy && !draft) { e.preventDefault(); void agent.cancel().catch(() => undefined); }
  };
  const paste = (e: ClipboardEvent) => { if (e.clipboardData.files.length) { e.preventDefault(); add(e.clipboardData.files); } };
  const dropped = (e: DragEvent) => { e.preventDefault(); setDrop(false); add(e.dataTransfer.files); };
  const grab = async () => { setMenu(false); try { add([await screenshot()]); } catch (e) { if ((e as Error).name !== "NotAllowedError") setNotice(voiceError(e)); } };
  const error = notice ?? problem(agent.error);
  const canShoot = typeof navigator !== "undefined" && "getDisplayMedia" in (navigator.mediaDevices ?? {}) && !/Android|iPhone|iPad/.test(navigator.userAgent);
  const speaking = voice?.kind === "call" && voice.state === "speaking";
  const callState = voice?.kind === "call" ? (speaking ? "Speaking" : !voice.handle ? "Starting" : voice.muted ? "Muted" : voice.state === "sending" ? "Sending" : busy ? "Working" : "Listening") : "";

  let row: ReactNode;
  if (voice?.kind === "listen") {
    row = (<>
      <button type="button" className="chat-ib" aria-label="Cancel" onClick={stopVoice}><Ic name="x" /></button>
      <Wave level={voice.handle && !voice.writing ? level.current : undefined} quiet={!voice.handle || voice.writing} />
      <span className="chat-live" role="status">{voice.writing ? <b className="chat-shimmer">Writing</b> : <span>{voice.handle ? clock : "Starting…"}</span>}</span>
      <button type="button" className="chat-ib primary" aria-label="Done" disabled={!voice.handle || voice.writing} onClick={() => void keepListening()}><Ic name="check" /></button>
    </>);
  } else if (voice?.kind === "call") {
    const muted = voice.muted;
    row = (<>
      <button type="button" className={`chat-ib${muted ? " on" : ""}`} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} disabled={!voice.handle}
        onClick={() => { voice.handle?.mute(!muted); setVoice({ ...voice, muted: !muted }); }}><Ic name={muted ? "micOff" : "mic"} /></button>
      <Wave level={speaking ? undefined : level.current} auto={speaking} quiet={!voice.handle || (muted && !speaking)} />
      <span className="chat-live" role="status"><b className={callState === "Muted" || callState === "Starting" ? "chat-dot" : "chat-dot on"}>{callState}</b><span>{clock}</span></span>
      <button type="button" className="chat-ib end" aria-label="End call" onClick={stopVoice}><Ic name="end" /></button>
    </>);
  } else {
    const ready = draft.trim() || files.length;
    row = (<>
      <button type="button" className={`chat-ib${menu ? " on" : ""}`} aria-label="Add" aria-expanded={menu} onClick={() => setMenu(!menu)}><Ic name="plus" /></button>
      <textarea ref={box} name="message" rows={1} value={draft} placeholder="Message the agent" aria-label="Message" disabled={resuming}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={keys} onPaste={paste} />
      <button type="button" className="chat-ib" aria-label="Talk to type" onClick={() => void startListening()}><Ic name="mic" /></button>
      {ready ? <button type="submit" className="chat-ib primary" aria-label="Send" disabled={resuming}><Ic name="up" /></button>
        : busy ? <button type="button" className="chat-ib primary" aria-label="Stop" onClick={() => void agent.cancel().catch(() => undefined)}><Ic name="stop" /></button>
        : <button type="button" className="chat-ib primary" aria-label="Voice call" disabled={resuming} onClick={() => void startCall()}><Ic name="wave" /></button>}
    </>);
  }

  return (
    <>
      <div className="title-row">
        <h1>Chat</h1>
        <button type="button" onClick={onNew} disabled={(!messages.length && !sessionId) || Boolean(voice)}>New chat</button>
      </div>
      <div className={`chat${drop ? " dropping" : ""}`} onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrop(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDrop(false); }} onDrop={dropped}>
        <div className="chat-log" ref={log} aria-live="polite" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
          <div className="chat-col">
            {!messages.length && !resuming && (
              <div className="chat-empty">
                <p>Ask about the company, its workflows and runs.</p>
                <p>The agent can change a workflow and start a run after your yes.</p>
              </div>
            )}
            {messages.map((m, i) => <Message key={m.id} message={m} live={busy && i === messages.length - 1} spoken={said.has(m.id) || (m.role === "user" && m.parts.some((p) => p.type === "text" && said.has(p.text.trim())))} />)}
            {asks.map(({ request }) => (
              <fieldset key={request.requestId} className="chat-ask" disabled={resuming}>
                <legend>{request.kind === "tool-approval" ? "Needs your yes" : "A question for you"}</legend>
                <p>{request.prompt}</p>
                <div className="chat-ask-options">
                  {request.options?.map((o) => {
                    const yes = request === approval && o === yesOption, no = request === approval && o === noOption;
                    return (
                      <button key={o.id} type="button" className={yes || (request !== approval && o.style === "primary") ? "primary" : undefined} onClick={() => respond(request.requestId, o.id)}>
                        {o.label}{yes && <kbd>{mod}↵</kbd>}{no && <kbd>Esc</kbd>}
                      </button>
                    );
                  })}
                </div>
                {request.kind !== "tool-approval" && (request.allowFreeform === true || !request.options?.length) && (
                  <form className="chat-answer" onSubmit={(e) => {
                    e.preventDefault();
                    const text = String(new FormData(e.currentTarget).get("answer") ?? "").trim();
                    if (text) void agent.respond([{ requestId: request.requestId, text }]).catch((err: Error) => setNotice(problem(err)));
                  }}>
                    <input name="answer" aria-label="Answer" placeholder="Your answer" autoComplete="off" />
                    <button type="submit" className="primary">Answer</button>
                  </form>
                )}
              </fieldset>
            ))}
            {busy && !asks.length && !messages.at(-1)?.parts.some((p) => p.type === "dynamic-tool" && running(p)) && <p className="chat-status"><span className="chat-shimmer">Working…</span></p>}
          </div>
        </div>
        <form className="chat-foot" onSubmit={submit}>
          <div className="chat-col">
            {error && <p className="chat-notice" role="alert">{error}</p>}
            <div className="chat-box">
              {menu && !voice && (
                <div className="chat-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); picker.current?.click(); }}><Ic name="file" />File or photo</button>
                  {canShoot && <button type="button" role="menuitem" onClick={() => void grab()}><Ic name="camera" />Screenshot</button>}
                  <hr />
                  <div className="chat-mode" role="radiogroup" aria-label="Mode">
                    {(["Ask", "Edit"] as const).map((m) => (
                      <button key={m} type="button" role="radio" aria-checked={(m === "Ask") === askOnly} onClick={() => { setAskOnly(m === "Ask"); save(MODE, m === "Ask" ? "ask" : undefined); }}>{m}</button>
                    ))}
                  </div>
                  <p className="chat-menu-hint">{askOnly ? "Answers only, changes nothing." : "May change workflows. Runs still need your yes."}</p>
                </div>
              )}
              {files.length > 0 && !voice && <div className="chat-atts">{files.map((a) => <Chip key={a.id} name={a.file.name} type={a.file.type} bytes={a.file.size} url={a.url} onRemove={() => remove(a.id)} />)}</div>}
              <div className="chat-row">{row}</div>
            </div>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          </div>
        </form>
      </div>
    </>
  );
}

/** Chat: the console's conversation with the project's agent. The current conversation comes back after a reload. */
export default function ChatView() {
  const [state, setState] = useState<{ key: number; session?: string } | null>(null);
  useEffect(() => setState({ key: 0, session: read(SAVED) }), []);
  if (!state) return null;
  return (
    <Conversation key={state.key} sessionId={state.session}
      onSession={(id) => save(SAVED, id)}
      onNew={() => { save(SAVED, undefined); setState({ key: state.key + 1 }); }} />
  );
}
