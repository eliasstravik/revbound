/**
 * revbound dev's agent: eve's own dev server for `agent/` on 127.0.0.1 (a free port, no terminal UI, none of eve's
 * bundled dev extensions), which the app proxies /eve/v1/* to (next.ts). It gets the app's environment minus the app's
 * own Workflow wiring, so eve's durable sessions run in eve's local world, not the app's.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { DevCtx, DevHandle } from "revbound/cli";

/** A free TCP port on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** The project's own eve CLI script, or undefined when eve is not installed. */
function eveBin(dir: string): string | undefined {
  try {
    const pkg = createRequire(join(dir, "package.json")).resolve("eve/package.json");
    return join(dirname(pkg), "bin", "eve.js");
  } catch {
    return undefined;
  }
}

export default async function agentDev(ctx: DevCtx): Promise<DevHandle | void> {
  const bin = eveBin(ctx.dir);
  if (!bin || !existsSync(join(ctx.dir, "agent"))) {
    console.log("revbound dev: the chat is off: run `npm install` (eve) and `npx revbound sync`.");
    return;
  }
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  ctx.env.REVBOUND_AGENT_URL = url;
  const env: NodeJS.ProcessEnv = { ...ctx.env, REVBOUND_DEV: "1", REVBOUND_PORT: String(ctx.port), REVBOUND_PROJECT_DIR: ctx.dir, EVE_TELEMETRY_DISABLED: "1" };
  for (const name of ["WORKFLOW_LOCAL_BASE_URL", "WORKFLOW_TARGET_WORLD", "PORT", "REVBOUND_AGENT_URL", "NODE_OPTIONS"]) delete env[name];
  let child: ChildProcess | undefined, stopping = false;
  const start = () => {
    child = spawn(process.execPath, [bin, "dev", "--no-ui", "--no-default-extensions", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: ctx.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    const relay = (d: Buffer) => {
      for (const line of String(d).split("\n")) if (line.trim() && !/waiting for sandbox command/.test(line)) console.log(`[agent] ${line}`);
    };
    child.stdout?.on("data", relay);
    child.stderr?.on("data", relay);
    child.once("exit", (code) => {
      if (!stopping) console.log(`revbound dev: the agent stopped (${code}); the chat answers again after a restart of npm run dev.`);
    });
  };
  start();
  return {
    started: () => console.log("revbound dev: the console's Chat page talks to the agent once it is ready."),
    stop: () => new Promise<void>((resolve) => {
      stopping = true;
      if (!child || child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child?.kill("SIGKILL"), 5000).unref();
    }),
  };
}
