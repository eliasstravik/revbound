/**
 * Voice for the console chat, through AI Gateway with the deployment's own OIDC (or AI_GATEWAY_API_KEY), so it needs no
 * voice key: talk to type sends a recording to a transcription model; a voice call sends each thing said the same way
 * and reads the agent's replies out with a speech model (speech.ts). The routes sit on the console's eve channel
 * (console.ts), so exactly the people who may use the chat reach them. AI Gateway's streaming and realtime voice take a
 * Gateway API key only, which is why the browser never talks to it directly.
 */
import { generateSpeech, transcribe, gateway } from "ai";
import type { AuthFn } from "eve/channels/auth";
import { GET, POST } from "eve/channels";
import { isHosted, value, type Env } from "revbound/kit";

export const VOICE_MODELS = { transcribe: "openai/gpt-4o-mini-transcribe", speech: "openai/tts-1" } as const;
/** The largest recording taken, under a Vercel Function's 4.5 MB request limit. */
export const MAX_AUDIO = 4_000_000;
/** The most of one reply read out (the speech model's limit is 4,096 characters). */
export const MAX_SPEECH = 4_000;

/** What stops voice here, as the fix; undefined when AI Gateway can be reached. */
export function voiceProblem(env: Env = process.env): string | undefined {
  if (isHosted(env) || value("AI_GATEWAY_API_KEY", env) || value("VERCEL_OIDC_TOKEN", env)) return undefined;
  return "Voice needs AI Gateway: run `vercel env pull`, or set AI_GATEWAY_API_KEY, then restart `npm run dev`.";
}

const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /eve/v1/voice → { ok } or the problem; POST /eve/v1/voice/transcribe (the recording) → { text };
 * POST /eve/v1/voice/speech ({ text }) → the audio. `auth` is the chat's own rule.
 */
export function voiceRoutes(auth: AuthFn<Request>, env: Env = process.env) {
  const refused = async (req: Request) => {
    try {
      await auth(req);
    } catch (error) {
      return fail((error as Error).message, 403);
    }
    const problem = voiceProblem(env);
    return problem ? fail(problem, 503) : undefined;
  };
  return [
    GET("/eve/v1/voice", async (req) => (await refused(req)) ?? Response.json({ ok: true }, { headers: { "cache-control": "no-store" } })),
    POST("/eve/v1/voice/transcribe", async (req) => {
      const no = await refused(req);
      if (no) return no;
      const audio = new Uint8Array(await req.arrayBuffer());
      if (!audio.length) return fail("Nothing was recorded.", 400);
      if (audio.length > MAX_AUDIO) return fail("That recording is too long: keep it to a few minutes.", 413);
      try {
        const { text } = await transcribe({ model: gateway.transcription(VOICE_MODELS.transcribe), audio, abortSignal: req.signal });
        return Response.json({ text: text.trim() }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return fail(`AI Gateway could not transcribe that: ${(error as Error).message}`, 502);
      }
    }),
    POST("/eve/v1/voice/speech", async (req) => {
      const no = await refused(req);
      if (no) return no;
      const { text } = (await req.json().catch(() => ({}))) as { text?: unknown };
      if (typeof text !== "string" || !text.trim()) return fail("Nothing to say.", 400);
      try {
        const { audio } = await generateSpeech({ model: gateway.speech(VOICE_MODELS.speech), text: text.slice(0, MAX_SPEECH), voice: "alloy", outputFormat: "mp3", abortSignal: req.signal });
        return new Response(audio.uint8Array as Uint8Array<ArrayBuffer>, { headers: { "content-type": audio.mediaType, "cache-control": "no-store" } });
      } catch (error) {
        return fail(`AI Gateway could not read that out: ${(error as Error).message}`, 502);
      }
    }),
  ];
}
