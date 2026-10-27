/**
 * Each person's own chats, enforced on the server: every console chat (an eve session) is saved with its owner, the
 * principal that created it, and every /eve/v1 route that names a session answers only that owner. A session the
 * console did not create (a Slack or Teams thread) has no owner here, so the console refuses it like any unknown id.
 * The list lives in the project's database (revbound_agent.chats), since eve keeps no per-person index of sessions.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AuthFn } from "eve/channels/auth";
import { routeAuth } from "eve/channels/auth";
import { DELETE, GET, type Channel } from "eve/channels";

export type Chat = { id: string; title: string; updatedAt: string };

/** The chats table, as the routes use it; every call names the owner. */
export type ChatStore = {
  /** Saves a new session as `owner`'s; false when the id is already someone else's. */
  claim(id: string, owner: string, title?: string): Promise<boolean>;
  owns(id: string, owner: string): Promise<boolean>;
  /** Marks a chat used now, and gives it a title when it has none. */
  touch(id: string, owner: string, title?: string): Promise<void>;
  list(owner: string): Promise<Chat[]>;
  /** Forgets the chat; false when it is not `owner`'s. */
  remove(id: string, owner: string): Promise<boolean>;
};

type Rows = (q: SQL) => Promise<Record<string, unknown>[]>;

/** The store over the project's database (`rows` runs one statement). */
export function chatStore(rows: Rows): ChatStore {
  return {
    async claim(id, owner, title) {
      const r = await rows(sql`insert into revbound_agent.chats (id, owner, title) values (${id}, ${owner}, ${title ?? null})
        on conflict (id) do nothing returning id`);
      return r.length === 1 || this.owns(id, owner);
    },
    async owns(id, owner) {
      return (await rows(sql`select 1 from revbound_agent.chats where id = ${id} and owner = ${owner}`)).length === 1;
    },
    async touch(id, owner, title) {
      await rows(sql`update revbound_agent.chats set updated_at = now(), title = coalesce(title, ${title ?? null})
        where id = ${id} and owner = ${owner}`);
    },
    async list(owner) {
      const r = await rows(sql`select id, title, updated_at from revbound_agent.chats where owner = ${owner}
        order by updated_at desc limit 200`);
      return r.map((c) => ({ id: String(c.id), title: c.title ? String(c.title) : "", updatedAt: new Date(c.updated_at as string).toISOString() }));
    },
    async remove(id, owner) {
      return (await rows(sql`delete from revbound_agent.chats where id = ${id} and owner = ${owner} returning id`)).length === 1;
    },
  };
}

/** The store over `db()` from the database plugin, loaded on first use so the agent starts without it. */
export function projectStore(): ChatStore {
  const rows: Rows = async (q) => {
    const { db } = await import("revbound/database/runtime");
    return (await db().execute(q)).rows as Record<string, unknown>[];
  };
  return chatStore(rows);
}

/** A chat's title: the start of its first message, on one line. */
export function titleOf(message: unknown): string | undefined {
  const parts = typeof message === "string" ? [{ type: "text", text: message }] : Array.isArray(message) ? message : [];
  const text = parts.find((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim())?.text
    ?? parts.find((p) => p?.type === "file" && typeof p.filename === "string")?.filename;
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line || undefined;
}

const NO_STORE = { "cache-control": "no-store" };
const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status, headers: NO_STORE });
/** The same answer for someone else's chat and one that does not exist, so ids cannot be probed. */
const notYours = () => fail(404, "This chat is not here. Start a new chat.");
const unavailable = (error: unknown) => {
  console.error("revbound agent: the chat list is unavailable, refusing", error);
  return fail(503, "Chats are unavailable right now. Try again in a moment.");
};

/** The message of a create or send request, read from a copy so the route still gets the body. */
async function messageOf(req: Request): Promise<unknown> {
  try { return ((await req.clone().json()) as { message?: unknown } | null)?.message; } catch { return undefined; }
}

/**
 * `channel` with every session route held to the session's owner, and the list routes:
 * GET /eve/v1/chats → { chats: [{ id, title, updatedAt }] }, newest first; DELETE /eve/v1/chats/:sessionId.
 * Fails closed: without the caller's identity or the database, no chat opens.
 */
export function ownChats(channel: Channel, auth: AuthFn<Request>, store: ChatStore): Channel {
  const owner = async (req: Request): Promise<string | Response> => {
    const result = await routeAuth(req, auth);
    if (result instanceof Response) return result;
    return result.principalType === "user" && result.principalId ? result.principalId : fail(403, "Sign in again to use the chat.");
  };
  const routes = channel.routes.map((route) => {
    if (route.transport !== "http") return route;
    const handler = route.handler;
    if (route.method === "POST" && route.path === "/eve/v1/session") {
      return { ...route, handler: async (req: Request, args: Parameters<typeof handler>[1]) => {
        const who = await owner(req);
        if (typeof who !== "string") return who;
        const [title, res] = [titleOf(await messageOf(req)), await handler(req, args)];
        if (!res.ok) return res;
        const id = res.headers.get("x-eve-session-id") ?? ((await res.clone().json().catch(() => null)) as { sessionId?: string } | null)?.sessionId;
        try {
          if (id && (await store.claim(id, who, title))) return res;
        } catch (error) {
          console.error("revbound agent: saving a new chat failed", error);
        }
        // Not saved, so no one could open it: end it and say so.
        if (id) await args.attachSession(id).reset({ reason: "not saved" }).catch(() => undefined);
        return unavailable("the new chat was not saved");
      } };
    }
    const param = /:(sessionId|parentSessionId)\b/.exec(route.path)?.[1];
    if (!param) return route;
    return { ...route, handler: async (req: Request, args: Parameters<typeof handler>[1]) => {
      const who = await owner(req);
      if (typeof who !== "string") return who;
      const id = args.params[param];
      try {
        if (!id || !(await store.owns(id, who))) return notYours();
        const message = route.method === "POST" && route.path === "/eve/v1/session/:sessionId" ? await messageOf(req) : undefined;
        if (message !== undefined) await store.touch(id, who, titleOf(message));
      } catch (error) {
        return unavailable(error);
      }
      return handler(req, args);
    } };
  });
  return {
    ...channel,
    routes: [
      ...routes,
      GET("/eve/v1/chats", async (req) => {
        const who = await owner(req);
        if (typeof who !== "string") return who;
        try { return Response.json({ ok: true, chats: await store.list(who) }, { headers: NO_STORE }); } catch (error) { return unavailable(error); }
      }),
      DELETE("/eve/v1/chats/:sessionId", async (req, args) => {
        const who = await owner(req);
        if (typeof who !== "string") return who;
        const id = args.params.sessionId;
        try {
          if (!id || !(await store.remove(id, who))) return notYours();
        } catch (error) {
          return unavailable(error);
        }
        await args.attachSession(id).reset({ reason: "deleted" }).catch(() => undefined);
        return Response.json({ ok: true }, { headers: NO_STORE });
      }),
    ],
  };
}
