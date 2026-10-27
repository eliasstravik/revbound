/**
 * The Chat page's voice, in the browser, over the voice routes (voice.ts):
 * - talk to type: a recording, written out when you finish.
 * - a voice call: it listens, and each time you pause it writes out what you said and passes it to the chat agent;
 *   the agent's replies are read out. Talking while it speaks cuts it off.
 */

/** What a failed microphone or voice request means for the person, with its fix. */
export function voiceError(error: unknown): string {
  const e = error as { name?: string; message?: string };
  if (e?.name === "NotAllowedError") return "Allow the microphone for this site to use voice.";
  if (e?.name === "NotFoundError") return "No microphone found.";
  return e?.message ?? String(error);
}

async function post(url: string, body: BodyInit, type: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { method: "POST", body, headers: { "content-type": type }, credentials: "same-origin", signal });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Voice failed (${res.status}).`);
  return res;
}

/** Undefined when voice works here, else what to do about it. */
export async function voiceReady(host: string): Promise<string | undefined> {
  const res = await fetch(`${host}/eve/v1/voice`, { credentials: "same-origin" }).catch(() => undefined);
  if (!res) return "The agent is not answering. Check that `npm run dev` is running, then try again.";
  return res.ok ? undefined : (((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Voice failed (${res.status}).`);
}

const written = async (host: string, audio: Blob, signal?: AbortSignal) =>
  ((await (await post(`${host}/eve/v1/voice/transcribe`, audio, audio.type || "application/octet-stream", signal)).json()) as { text: string }).text;

export const microphone = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });

/** How loud the stream is now, 0 to 1, read on each call (for the wave). */
export function meter(stream: MediaStream): { level(): number; stop(): void } {
  const audio = new AudioContext(), analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  audio.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  return {
    level() {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    },
    stop: () => void audio.close().catch(() => undefined),
  };
}

export type Listening = { stream: MediaStream; finish(): Promise<string>; cancel(): void };

/** Talk to type: records until finish(), which resolves with the words. */
export async function listen(host: string): Promise<Listening> {
  const stream = await microphone();
  const rec = new MediaRecorder(stream), chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start(1000);
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stream,
    async finish() {
      const stopped = new Promise((resolve) => { rec.onstop = resolve; });
      rec.stop();
      await stopped;
      release();
      const audio = new Blob(chunks, { type: rec.mimeType });
      return audio.size ? written(host, audio) : "";
    },
    cancel() { if (rec.state !== "inactive") rec.stop(); release(); },
  };
}

// An AudioWorklet that hands over the microphone's samples as they come.
const WORKLET = `registerProcessor("mic-tap", class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

/** Samples as a 16-bit mono WAV file. */
export function wav(chunks: Float32Array[], rate: number): Blob {
  const n = chunks.reduce((sum, c) => sum + c.length, 0), view = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, n * 2, true);
  let at = 44;
  for (const c of chunks) for (const s of c) { view.setInt16(at, Math.max(-1, Math.min(1, s)) * 0x7fff, true); at += 2; }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/** Markdown as words to say: no code, link targets or markup. */
export function speakable(md: string): string {
  return md.replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "the link")
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, "").replace(/[`*#>|~]/g, "").replace(/_/g, " ").replace(/[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n").trim();
}

export type CallState = "listening" | "sending" | "speaking";
export type CallHandle = { stream: MediaStream; say(text: string): void; mute(on: boolean): void; end(): void };

/** Pauses that end what you said, how long one can be, and how loud speech is over the room. */
const PAUSE_MS = 900, LONGEST_MS = 30_000, SHORTEST_MS = 300, BEFORE_MS = 300;

/** Starts a call. `send` passes what the person said to the chat agent; `say` reads the agent's replies out. */
export async function call(host: string, opts: { send(text: string): void; onState(state: CallState): void; onError(message: string): void }): Promise<CallHandle> {
  // Made before anything is awaited, inside the tap that started the call, so phones let it play sound.
  const ctx = new AudioContext();
  const no = await voiceReady(host);
  if (no) { void ctx.close(); throw new Error(no); }
  const stream = await microphone().catch((e) => { void ctx.close(); throw e; });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw e;
  } finally {
    URL.revokeObjectURL(url);
  }
  const tap = new AudioWorkletNode(ctx, "mic-tap");
  ctx.createMediaStreamSource(stream).connect(tap);
  const abort = new AbortController(), ms = (samples: number) => (samples / ctx.sampleRate) * 1000;
  let state: CallState = "listening", muted = false, ended = false, sending = 0;
  const set = (next: CallState) => { if (state !== next && !ended) opts.onState((state = next)); };

  // ---- speaking: one reply at a time, cut off when the person talks
  const queue: string[] = [];
  let playing: AudioBufferSourceNode | undefined;
  const hush = () => { queue.length = 0; if (playing) { playing.onended = null; playing.stop(); playing = undefined; } };
  const next = async () => {
    if (playing || ended) return;
    const text = queue.shift();
    if (text === undefined) return set(sending ? "sending" : "listening");
    try {
      const res = await post(`${host}/eve/v1/voice/speech`, JSON.stringify({ text }), "application/json", abort.signal);
      const sound = await ctx.decodeAudioData(await res.arrayBuffer());
      if (ended || playing) return;
      playing = ctx.createBufferSource();
      playing.buffer = sound;
      playing.connect(ctx.destination);
      playing.onended = () => { playing = undefined; void next(); };
      set("speaking");
      playing.start();
    } catch (e) {
      if (!ended) { opts.onError(voiceError(e)); void next(); }
    }
  };

  // ---- listening: what is said between pauses, with a moment before it so its first word is whole
  let floor = 0.01, loudFor = 0, quietFor = 0, speech: Float32Array[] | undefined;
  const before: Float32Array[] = [];
  const finish = async (said: Float32Array[]) => {
    sending++;
    if (!playing) set("sending");
    try {
      const text = await written(host, wav(said, ctx.sampleRate), abort.signal);
      if (text && !ended) opts.send(text);
    } catch (e) {
      if (!ended) opts.onError(voiceError(e));
    } finally {
      sending--;
      if (!playing && !queue.length) set(sending ? "sending" : "listening");
    }
  };
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (ended || muted) return;
    const chunk = e.data, rms = Math.sqrt(chunk.reduce((sum, s) => sum + s * s, 0) / chunk.length);
    // Its own voice can come back through the microphone: while it speaks, only clearly louder sound counts.
    const loud = rms > Math.max(0.015, floor * 3) * (playing ? 2.5 : 1);
    if (!speech) {
      if (!loud) floor = floor * 0.98 + rms * 0.02;
      before.push(chunk);
      while (before.length && ms(before.reduce((sum, c) => sum + c.length, 0)) > BEFORE_MS) before.shift();
      loudFor = loud ? loudFor + ms(chunk.length) : 0;
      if (loudFor < 120) return;
      hush();
      speech = [...before];
      quietFor = 0;
      return;
    }
    speech.push(chunk);
    quietFor = loud ? 0 : quietFor + ms(chunk.length);
    const length = ms(speech.reduce((sum, c) => sum + c.length, 0));
    if (quietFor < PAUSE_MS && length < LONGEST_MS) return;
    const said = speech;
    speech = undefined;
    loudFor = 0;
    if (length - quietFor >= SHORTEST_MS) void finish(said);
  };

  return {
    stream,
    say(text) { const words = speakable(text); if (words) { queue.push(words); void next(); } },
    mute(on) { muted = on; if (on) speech = undefined; },
    end() {
      ended = true;
      abort.abort();
      hush();
      tap.port.onmessage = null;
      tap.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    },
  };
}
