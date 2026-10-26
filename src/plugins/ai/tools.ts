import { FatalError } from "workflow";
import { value } from "revbound/kit";

/**
 * The built-in tools of agent(), each run in one of the ai plugin's steps: MCP over Streamable HTTP (plain JSON-RPC
 * through fetch) and fetch_page. Only plain JSON crosses the step boundary; keys are read from the environment there.
 */
export type McpServer = {
  /** The server's HTTP endpoint. */
  url: string;
  /** Name of the variable that holds the key (e.g. MONID_API_KEY); the value never appears in code, prompts or the run log. Omit for a public server. */
  keyEnv?: string;
  /** Header the key goes in; Authorization by default, sent as `Bearer <key>` unless `bearer` is false. */
  header?: string;
  bearer?: boolean;
  /** Only these tool names are offered to the model. */
  allow?: string[];
  /** Per-request timeout; 45 seconds by default. */
  timeoutMs?: number;
};

export type McpToolDefinition = { name: string; description?: string; inputSchema: Record<string, unknown> };

const PAYLOAD_LIMIT = 400_000;
const PAGE_CHARS = 8000;
const MAX_REDIRECTS = 3;

/** The server's allowed tool definitions, listed once per stage. */
export async function listMcpTools(server: McpServer): Promise<McpToolDefinition[]> {
  return mcpSession(server, async (rpc) => {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc("tools/list", cursor ? { cursor } : {});
      for (const t of page.tools ?? []) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: "object", properties: {} } });
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools.filter((t) => !server.allow || server.allow.includes(t.name));
  });
}

/**
 * One tool call (its step is never retried: the call may be billed). The result is the server's structured content, else its
 * text parsed as JSON when possible. A tool error comes back as `{ isError, error }` so the model can try another way.
 */
export async function callMcpTool(server: McpServer, name: string, args: unknown): Promise<unknown> {
  if (server.allow && !server.allow.includes(name)) return { isError: true, tool: name, error: `${name} is not allowed` };
  return mcpSession(server, async (rpc) => {
    const result = await rpc("tools/call", { name, arguments: args ?? {} });
    const content = bound(result.structuredContent ?? parseContent(result.content));
    return result.isError ? { isError: true, tool: name, error: content } : content;
  });
}

/** Step side: the server's auth header from its key variable. A missing key fails the stage, not just the call. */
export function mcpAuth(server: McpServer): Record<string, string> {
  if (!server.keyEnv) return {};
  const key = value(server.keyEnv);
  const url = new URL(server.url);
  if (!key) throw new FatalError(`Set ${server.keyEnv} for the MCP server at ${url.hostname}`);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new FatalError(`MCP keys go only over https, not to ${url.hostname}`);
  return { [server.header ?? "Authorization"]: server.bearer === false ? key : `Bearer ${key}` };
}

type Rpc = (method: string, params?: unknown) => Promise<any>;

/** initialize → notifications/initialized → `use` → DELETE the session. Replies may be JSON or an SSE stream. */
async function mcpSession<T>(server: McpServer, use: (rpc: Rpc) => Promise<T>): Promise<T> {
  const host = new URL(server.url).hostname;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...mcpAuth(server) };
  let next = 0;
  const rpc: Rpc = async (method, params) => {
    const id = method.startsWith("notifications/") ? undefined : ++next;
    const res = await fetch(server.url, {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(server.timeoutMs ?? 45_000),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const session = res.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    if (!res.ok) throw new Error(`MCP server ${host} answered HTTP ${res.status} to ${method}`);
    const text = await res.text();
    if (id === undefined) return;
    const messages = res.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n\r?\n/).map((e) => e.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")).filter(Boolean).map((d) => JSON.parse(d))
      : [JSON.parse(text)];
    const reply = messages.flat().find((m) => m?.id === id);
    if (!reply) throw new Error(`MCP server ${host} sent no reply to ${method}`);
    if (reply.error) throw new Error(`MCP server ${host}: ${method} failed: ${String(reply.error.message).slice(0, 300)}`);
    return reply.result;
  };
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "revbound", version: "1" } });
  headers["mcp-protocol-version"] = init?.protocolVersion ?? "2025-06-18";
  await rpc("notifications/initialized");
  try {
    return await use(rpc);
  } finally {
    if (headers["mcp-session-id"]) await fetch(server.url, { method: "DELETE", headers, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  }
}

function parseContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const texts = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string);
  if (texts.length === 0) return content;
  try { return JSON.parse(texts.join("\n")); } catch { return texts.join("\n"); }
}

function bound(v: unknown): unknown {
  const text = JSON.stringify(v) ?? "";
  return text.length <= PAYLOAD_LIMIT ? v : { truncated: true, json: text.slice(0, PAYLOAD_LIMIT) };
}

/** Readable text of one public page, uncached. Every redirect hop is checked like the first address. */
export async function fetchPage(url: string): Promise<{ url: string; text: string } | { isError: true; error: string }> {
  const { lookup } = await import("node:dns/promises");
  try {
    let current = publicUrl(url);
    for (let hop = 0; ; hop += 1) {
      const host = new URL(current).hostname;
      const addresses = await lookup(host, { all: true }).catch(() => []);
      if (addresses.length === 0) throw new Error(`${host} does not resolve`);
      if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error(`${host} resolves to a private address`);
      const res = await fetch(current, { headers: { "user-agent": "revbound", accept: "text/html,application/xhtml+xml,text/plain" }, signal: AbortSignal.timeout(20_000), redirect: "manual" });
      const location = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && location) {
        if (hop >= MAX_REDIRECTS) throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times`);
        current = publicUrl(new URL(location, current).toString());
        continue;
      }
      if (!res.ok) throw new Error(`${current} answered HTTP ${res.status}`);
      const text = (await res.text())
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim()
        .slice(0, PAGE_CHARS);
      return { url: current, text };
    }
  } catch (error) {
    return { isError: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Only public http(s) addresses by name: no IP literals, localhost, internal names or credentials in the URL. */
function publicUrl(input: string): string {
  const full = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  if (!URL.canParse(full)) throw new Error(`Not a web address: ${input}`);
  const u = new URL(full);
  const host = u.hostname.toLowerCase();
  if (!/^https?:$/.test(u.protocol) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || host.includes(":") || !host.includes(".") ||
    /\.(local|internal|localhost|home|lan|arpa)$/.test(host) || u.username || u.password) throw new Error(`Not a public web address: ${input}`);
  u.hash = "";
  return u.toString();
}

/** Private, loopback, link-local, carrier-grade NAT, benchmark, multicast and metadata ranges. */
function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.includes(":")) {
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fec0:");
  }
  const [a, b] = v.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
