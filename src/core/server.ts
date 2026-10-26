import { routeAccess, secretName } from "../kit/access.js";
import { isBranded } from "../kit/brand.js";
import { context, loadFresh } from "../kit/ctx.js";
import { HttpError, json } from "../kit/http.js";
import { decodePath, find } from "../kit/patterns.js";
import type { Handler, Manifest, SlotMap } from "./types.js";

/** What _revbound/routes.ts maps each route key (`<plugin>:<path>`) to: its handler module and its plugin's slot map. */
export type Handlers = Record<string, { load: () => Promise<{ default: Handler }>; map: () => Promise<{ default: SlotMap }> }>;
type NextHandler = (req: Request, ctx: { params: Promise<{ path?: string[] }> }) => Promise<Response>;

/**
 * The handlers behind app/api/revbound/[...path]/route.ts: the declared route for the path, its access mode checked again
 * behind the proxy, then its handler with the plugin's context. Responses are never cached; errors are `{ error }`.
 */
export function revboundRoutes(manifest: Manifest, handlers: Handlers): { GET: NextHandler; POST: NextHandler } {
  const handle: NextHandler = async (req, next) => {
    try {
      const path = decodePath(((await next.params).path ?? []).join("/"));
      const method = req.method === "HEAD" ? "GET" : req.method;
      // The route for this method; a path with routes for other methods only answers 405.
      const hit = path && (find(manifest.routes, path, (r) => (r.methods as string[]).includes(method)) ?? find(manifest.routes, path));
      if (!path || !hit) throw new HttpError(404, `No such endpoint: /api/revbound/${(path ?? []).join("/")}`);
      if (!(hit.item.methods as string[]).includes(method)) throw new HttpError(405, `${req.method} is not allowed here.`);
      const verdict = routeAccess(hit.item.access, req, secretName(hit.item.secret, hit.params));
      if (!verdict.ok) throw new HttpError(verdict.status, verdict.error);
      const entry = handlers[hit.item.key];
      if (!entry) throw new HttpError(500, `The route ${hit.item.key} has no handler; run revbound sync.`);
      const [{ default: handler }, { default: map }] = await Promise.all([loadFresh(entry.load), loadFresh(entry.map)]);
      if (hit.item.access === "signature" && !isBranded(handler)) {
        throw new HttpError(500, `The webhook route ${hit.item.key} is not built with webhook(), so it is refused.`);
      }
      const res = await handler(req, { ...context(manifest, map), params: hit.params, path });
      if (!res.headers.has("cache-control")) res.headers.set("cache-control", "no-store");
      return res;
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("[revbound] API error", error);
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
  return { GET: handle, POST: handle };
}
