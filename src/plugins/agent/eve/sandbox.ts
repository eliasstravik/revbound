/**
 * The agent's sandbox: where its shell and file tools work, always with the project at /workspace and never with a key.
 *
 * - Deployed: a Vercel Sandbox made at build time from the deployed commit's files (keys and build output left out) as
 *   a one-commit git repository with npm packages installed. It reaches only GitHub and the npm registry; GitHub's
 *   credential is added at its firewall one command at a time (git.ts).
 * - On a laptop: eve's just-bash shell over the project folder itself, so edits land in the person's files. Files that
 *   hold keys or local state are hidden, files that run on their own under `npm run dev` are read-only (guard), and
 *   nothing runs on the host: no project code, no git.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox, type JustBashFilesystem } from "eve/sandbox/just-bash";
import { VercelSandbox } from "eve/sandbox/vercel";
import { onVercel } from "../app.js";

/** The hosts the deployed sandbox reaches. */
export const HOSTS = ["registry.npmjs.org", "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com"];
export const EGRESS: Record<string, []> = Object.fromEntries(HOSTS.map((h) => [h, []]));

/** Project paths the agent never sees: keys, local data, build output and other tools' state. */
export function hidden(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (/^\.env/.test(name) && name !== ".env.example") return true;
  // Revbound's own package stays readable (its docs and skill).
  if (parts[0] === "node_modules" && (parts.length === 1 || parts[1] === "revbound")) return false;
  // Files people attach in the chat: eve stages them under .eve/attachments for the agent to read; the rest of .eve stays hidden.
  if (parts[0] === ".eve" && (parts.length === 1 || parts[1] === "attachments")) return false;
  return parts.some((p) => [".vercel", ".revbound", ".workflow-data", ".eve", ".git", "node_modules", ".next", ".output"].includes(p));
}

/**
 * What the deployed sandbox starts with: the project as built, minus what `hidden` leaves out, with its links (such as
 * agent/skills) kept as links.
 */
export function seedFiles(root: string): { files: { path: string; content: Uint8Array }[]; links: { path: string; target: string }[] } {
  const files: { path: string; content: Uint8Array }[] = [], links: { path: string; target: string }[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (hidden(path) || ["node_modules", "app/.well-known", ".eve"].includes(path)) continue;
      const st = lstatSync(join(root, path), { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) links.push({ path, target: readlinkSync(join(root, path)) });
      else if (st?.isDirectory()) walk(path);
      else if (st?.isFile() && st.size < 5_000_000) files.push({ path: `/workspace/${path}`, content: readFileSync(join(root, path)) });
    }
  };
  walk("");
  return { files, links };
}

/** A shell word in single quotes. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------- deployed

const commit = process.env.VERCEL_GIT_COMMIT_SHA || "local";

const vercel = () => VercelSandbox.environment({
  // A new snapshot per deployment (a `vercel deploy` has no commit), so the workspace is always what is being served.
  env: { REVBOUND_DEPLOYMENT: process.env.VERCEL_DEPLOYMENT_ID || commit },
  async prepare(sandbox) {
    const { files, links } = seedFiles(process.cwd());
    await sandbox.writeFiles({ files });
    const steps = [
      ...links.map((l) => `mkdir -p ${quote(dirname(l.path))} && ln -s ${quote(l.target)} ${quote(l.path)}`),
      "npm ci --no-audit --no-fund --ignore-scripts",
      // A `vercel deploy` sends no .gitignore (the build may leave a stub): add the starter's lines it lacks, so git and
      // `revbound check` see what they would in the repo.
      "touch .gitignore && { [ -z \"$(tail -c1 .gitignore)\" ] || echo >> .gitignore; } && { grep -vxFf .gitignore node_modules/revbound/starter/gitignore >> .gitignore || true; }",
      "git init -q -b main",
      "git add -A",
      `git -c user.name=revbound -c user.email=revbound@users.noreply.github.com commit -qm "Deployed ${commit}"`,
    ];
    for (const command of steps) {
      const r = await sandbox.run({ command, workingDirectory: "/workspace" });
      if (r.exitCode !== 0) throw new Error(`Preparing the agent's workspace failed at \`${command}\`: ${(r.stderr || r.stdout).slice(-800)}`);
    }
  },
});

// ---------------------------------------------------------------- laptop

/** Project files that run on their own under `npm run dev` (sync's watcher, the dev server's config): never written. */
const WIRING = ["revbound.config.ts", "package.json", "package-lock.json", "next.config.ts", "proxy.ts", "tsconfig.json",
  "drizzle.config.ts", "vercel.json", ".env.example", ".gitignore"];

/** Paths the agent may read but not write on a laptop: the wiring, generated code, local plugins and non-Markdown skill files. */
export function locked(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 1 && WIRING.includes(parts[0])) return true;
  if (["plugins", "app", "_revbound", "agent", "node_modules", ".claude", "public"].includes(parts[0] ?? "")) return true;
  return parts[0] === ".agents" && !/\.md$/i.test(parts.at(-1) ?? "");
}

const WRITES = ["writeFile", "appendFile", "mkdir", "rm", "cp", "mv", "chmod", "utimes"];

/** The first hidden or locked path inside folder `dir`, if `dir` is a folder. */
async function held(fs: JustBashFilesystem, dir: string): Promise<string | undefined> {
  const st = await fs.stat(dir).catch(() => undefined);
  if (!st?.isDirectory) return undefined;
  for (const name of await fs.readdir(dir)) {
    const p = `${dir.replace(/\/$/, "")}/${name}`;
    if (hidden(p) || locked(p)) return p;
    const deeper = await held(fs, p);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}
const fail = (code: string, what: string) => Promise.reject(Object.assign(new Error(`${code}: ${what}`), { code }));

/**
 * The project folder as the laptop shell sees it. `hidden` paths are gone: reads fail as missing, listings leave them
 * out. `locked` paths are read-only. No links can be made (one could lead a write past either rule), and a directory
 * copy, which would carry hidden files along, is refused. Paths are the folder's own (`/.env.local`), as the shell's
 * mount passes them.
 */
export function guard(fs: JustBashFilesystem): JustBashFilesystem {
  const isHidden = (p: unknown) => typeof p === "string" && hidden(p);
  return new Proxy(fs, {
    get(target, key) {
      const v = Reflect.get(target, key) as unknown;
      if (typeof v !== "function") return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (key === "readdir") return async (p: string) => ((await fn.call(target, p)) as string[]).filter((n) => !isHidden(`${p.replace(/\/$/, "")}/${n}`));
      if (key === "readdirWithFileTypes") return async (p: string) => ((await fn.call(target, p)) as { name: string }[]).filter((e) => !isHidden(`${p.replace(/\/$/, "")}/${e.name}`));
      if (key === "exists") return async (p: string) => !isHidden(p) && (await fn.call(target, p));
      if (key === "getAllPaths") return () => (fn.call(target) as string[]).filter((p) => !isHidden(p));
      if (key === "resolvePath") return fn.bind(target);
      if (key === "symlink" || key === "link") return () => fail("EPERM", "links cannot be made here");
      // Every remaining member is async.
      return async (...args: unknown[]) => {
        // The path arguments: two for a copy or move, else the first (a write's second is the content).
        const paths = args.slice(0, ["cp", "mv"].includes(String(key)) ? 2 : 1).filter((a): a is string => typeof a === "string");
        const gone = paths.find(hidden);
        if (gone !== undefined) return fail("ENOENT", `no such file or directory, '${gone}'`);
        if (WRITES.includes(String(key))) {
          const ro = paths.find(locked);
          if (ro !== undefined) return fail("EROFS", `${ro} is read-only here: it runs on its own under npm run dev; ask the person to change it`);
        }
        if (key === "cp" && (await target.stat(paths[0])).isDirectory) return fail("EPERM", `copy the files of ${paths[0]} one by one here`);
        // A write to a folder (rm -r, mv) reaches everything in it: refuse one that holds a hidden or read-only path.
        if (WRITES.includes(String(key))) {
          for (const p of paths) {
            const inside = await held(target, p);
            if (inside !== undefined) return fail("EROFS", `${p} holds ${inside}, which is read-only here`);
          }
        }
        return fn.apply(target, args);
      };
    },
  });
}

/**
 * The project folder for the laptop shell: guarded, and never following a link, so a link already in the project (say
 * context/x.md → ../.env.local) cannot lead past `hidden` or `locked`.
 */
export function projectFs(ReadWriteFs: new (o: { root: string; allowSymlinks: boolean }) => unknown, root: string): JustBashFilesystem {
  return guard(new ReadWriteFs({ root, allowSymlinks: false }) as JustBashFilesystem);
}

const laptop = () => JustBashSandbox.environment({
  autoInstall: false,
  async filesystem({ defaultFilesystem, justBash, resolveProjectPath }) {
    const project = projectFs(justBash.ReadWriteFs, resolveProjectPath("."));
    return new justBash.MountableFs({ base: defaultFilesystem as never, mounts: [{ mountPoint: "/workspace", filesystem: project as never }] }) as unknown as JustBashFilesystem;
  },
});

export const environment = onVercel() ? vercel() : laptop();

export default defineSandbox(() => (onVercel()
  ? (environment as ReturnType<typeof vercel>).open({ networkPolicy: { allow: EGRESS } })
  : environment.open()));
