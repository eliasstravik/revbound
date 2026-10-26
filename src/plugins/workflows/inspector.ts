/**
 * The Workflow SDK's own run inspector (`@workflow/web`), served by the local console under /api/revbound/inspector:
 * `/api/revbound/inspector` lists runs, `/api/revbound/inspector/run/<id>` shows one. The route is `local`: loopback only.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { basePath } from "revbound/kit";

const BASE = `${basePath()}/api/revbound/inspector`;

type Handler = (req: Request) => Promise<Response>;
let handler: Promise<Handler> | undefined;

/** @workflow/web through the project's `workflow` dependency (its CLI or Nitro package), so Revbound adds no dependency. */
function load(): Promise<Handler> {
  handler ??= (async () => {
    const from = (base: string, id: string) => createRequire(base).resolve(id);
    const workflow = from(join(process.cwd(), "package.json"), "workflow");
    let url: string | undefined;
    for (const via of ["@workflow/cli/package.json", "@workflow/nitro"]) {
      try { url = pathToFileURL(from(from(workflow, via), "@workflow/web/handler")).href; break; } catch {}
    }
    if (!url) throw new Error("The run inspector (@workflow/web) is not installed with the workflow package. Run `npm install`.");
    const web = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ url);
    const serve: Handler = await web.createWorkflowWebHandler({ basename: BASE });
    return async (req: Request) => {
      const res = await serve(req);
      // Files come as a stream of the file that Next's compression closes twice (an uncaught ERR_INVALID_STATE per
      // file in the dev log), so they are read whole; its stylesheet loads the fonts from /assets/, outside the basename.
      if (res.status !== 200 || !/\.\w+$/.test(new URL(req.url).pathname) || req.method !== "GET") return res;
      const headers = new Headers(res.headers);
      if (!headers.get("content-type")?.includes("text/css")) return new Response(await res.arrayBuffer(), { headers });
      headers.delete("content-length");
      return new Response((await res.text()).replaceAll("url(/assets/", `url(${BASE}/assets/`), { headers });
    };
  })().catch((error) => { handler = undefined; throw error; });
  return handler;
}

export async function inspector(req: Request): Promise<Response> {
  return (await load())(req);
}
