/**
 * The plugin contract (`api: 1`), the slot interfaces (`V1`), the manifest `revbound sync` writes and the workflow registry.
 * Types only: every module may import it, in any scope.
 */

/** A module specifier whose default export is the value; `<specifier>#<name>` names another export. */
export type Code = string;

export type Access = "session" | "console" | "automation" | "cron" | "signature" | "local" | "tailnet";
export type Method = "GET" | "POST";
export type Capability = "spends" | "sends" | "writesPeople";

export type RouteDecl = {
  /** Under /api/revbound/: fixed segments, `:param` segments and a final `*`. */
  path: string;
  methods: Method[];
  access: Access;
  handler: Code;
  /** `signature` only: the variable holding the sender's bypass secret; `{param}` is replaced by that path parameter. */
  secret?: string;
};

/** `nav.count`: a session route answering { count }, shown as a badge; `fill`: the view scrolls its own table under a fixed toolbar. */
export type ViewDecl = { path: string; title: string; nav?: { label: string; order: number; count?: string }; fill?: boolean; component: Code };
export type TabDecl = { id: string; title: string; order?: number; component: Code };
export type CliDecl = { name: string; describe: string; run: Code };

export interface RevboundPlugin {
  /** Unique, kebab-case; also the binding-file and alias name. */
  name: string;
  api: 1;
  provides?: string[];
  /** The slot implementation: default export `(ctx) => Slot`. */
  provide?: Code;
  needs?: string[];
  uses?: string[];
  capabilities?: Capability[];
  /** Helpers company code imports via `#revbound/<name>`: `from` exports `bind(rt)`, `step` the step-side `run(ctx, op, args)`. */
  runtime?: { from: Code; exports: string[]; step?: Code };
  /** Own Postgres schema; default "revbound_" + name (snake_case). */
  schema?: string;
  /** Folder of `NNNN_name.sql` migrations, as a package path or a project path. */
  migrations?: string;
  tables?: { schema: string; name: string; label?: string }[];
  routes?: RouteDecl[];
  views?: ViewDecl[];
  workflowTabs?: TabDecl[];
  connections?: { name: string; label: string }[];
  cli?: CliDecl[];
  /** AGENTS.md fragment (markdown). */
  agents?: string;
  /** Skill folders; sync installs each as .agents/skills/<plugin>-<folder>. */
  skills?: string[];
  /** Project files this plugin owns, written by sync: path → contents, or `{ link }` for a symbolic link to that target. */
  files?: Record<string, string | { link: string }>;
  /** Topic → markdown file; `revbound docs <topic>`. */
  docs?: Record<string, string>;
  /** Default export: (ctx) => Promise<CheckResult[]>. */
  checks?: Code;
  trace?: string[];
  /** Default export: (cfg: NextConfig) => NextConfig, applied by withRevbound. */
  next?: Code;
  /** Default export: (ctx) => Promise<DevHandle | void>, run by `revbound dev` before the app starts. */
  dev?: Code;
  /** The console shell: this plugin owns app/layout.tsx (`layout`) and app/[[...path]]/page.tsx (`page`). */
  shell?: { layout: Code; page: Code };
  /** Project modules this plugin's code receives through ctx.module(name). */
  modules?: Record<string, Code>;
  /** Plain JSON options, copied into the manifest. */
  options?: unknown;
}

export type RevboundConfig = {
  company: string;
  plugins: RevboundPlugin[];
  acknowledge?: { customLedger?: boolean; destructive?: string[] };
};

export type CheckResult = { level: "error" | "warning" | "info"; message: string; fix?: string };

export type ManifestPlugin = {
  name: string; provides: string[]; needs: string[]; uses: string[]; capabilities: Capability[]; schema: string;
  runtime?: string[]; migrations?: string; options?: unknown; package?: string;
};
export type ManifestRoute = Omit<RouteDecl, "handler"> & { plugin: string; key: string };
export type ManifestView = Omit<ViewDecl, "component"> & { plugin: string };
export type ManifestTab = Omit<TabDecl, "component"> & { plugin: string };

/** What `revbound sync` writes to _revbound/manifest.ts: plain data the proxy, the routes and the console read. */
export type Manifest = {
  api: 1;
  version: string;
  company: string;
  plugins: ManifestPlugin[];
  /** Slot → the plugin that provides it. */
  slots: Record<string, string>;
  routes: ManifestRoute[];
  views: ManifestView[];
  tabs: ManifestTab[];
  connections: { name: string; label: string; plugins: string[] }[];
  tables: { plugin: string; schema: string; name: string; label?: string }[];
  acknowledge: { customLedger: boolean; destructive: string[] };
};

/** A plugin's slot map (_revbound/slots/<plugin>.ts): its providers, each with its own map, and its project modules. */
export type SlotMap = {
  plugin: string;
  slots: Record<string, { plugin: string; provide: unknown; map: { default: SlotMap } }>;
  modules: Record<string, () => Promise<unknown>>;
};

/** What plugin code gets inside steps and routes: the manifest, its options, slots by name, project modules. */
export type Ctx = {
  manifest: Manifest;
  plugin: string;
  options: any;
  has(slot: string): boolean;
  get<S extends keyof Slots>(slot: S): Slots[S];
  get<T = unknown>(slot: string): T;
  module<T = unknown>(name: string): Promise<T>;
};

export type RouteCtx = Ctx & { params: Record<string, string>; path: string[] };
export type Handler = (req: Request, ctx: RouteCtx) => Promise<Response> | Response;

/** The handle a binding file passes to its runtime module's `bind`. */
export type Runtime = {
  plugin: string;
  /** A "use step" call of the plugin's step module: run(ctx, op, args); inline when already inside a step. */
  step(op: string, args: unknown[]): Promise<unknown>;
  /** The same, never retried. */
  once(op: string, args: unknown[]): Promise<unknown>;
};

// ---------------------------------------------------------------- slots

export type MigrationPlan = { sets: { id: string; schema: string; folder: string }[]; company?: string; destructive: string[] };

export interface DatabaseSlotV1 {
  /** The project's Drizzle database (node-postgres). */
  db(): import("drizzle-orm/node-postgres").NodePgDatabase;
  migrate(plan: MigrationPlan, url: string): Promise<number>;
  /** Marks the database as production's (hosted production only). */
  stamp(url: string): Promise<void>;
}

export type Trigger = "cli" | "http" | "cron" | "webhook" | "child" | "external";
export type RunStatus = "admitted" | "running" | "completed" | "failed" | "cancelled" | "unknown" | "refused" | "start_failed";

export type AdmitRequest = {
  workflow: string; input: unknown; trigger: Trigger; preview?: boolean;
  approve?: { maxUsd: number; note?: string };
  parent?: { runId: string; childKey: string };
};
export type Admission = { ok: true; runId: string; rootId: string; preview: boolean; approved: boolean; existing?: string } | { ok: false; reason: string; runId?: string };

export type ReserveRequest = {
  sdkRunId: string; plugin: string; kind: string; target?: string; idempotencyKey: string;
  /** Null: unmetered (counts as a call, reserves no money). */
  estimateUsd: number | null;
  keys?: { email?: string; domain?: string; linkedin?: string };
  detail?: Record<string, unknown>;
  /** The step attempt asking: only a later attempt of the same step takes over a reservation left open under the key. */
  holder?: { step: string; attempt: number };
};
export type Reservation = { ok: true; id: string; runId: string; rootId: string; repeat?: "ok" | "reserved" } | { ok: false; reason: string; id?: string };

export type LedgerRun = {
  id: string; sdkRunId: string | null; workflow: string; trigger: Trigger; preview: boolean; status: RunStatus; reason: string | null;
  parentRunId: string | null; rootRunId: string; approvedMaxUsd: number | null; approvalNote: string | null;
  startedAt: string; finishedAt: string | null; costUsd: number | null; reservedUsd: number; calls: number; unmetered: number;
};
export type Limits = {
  approval: { required: boolean; previewItems: number; previewCalls: number; previewMaxUsd: number; previewWithinHours: number };
  perRunUsd: number; perMonthUsd: number; projectMonthUsd: number;
  schedule?: { approvedUntil: string; note: string };
};

export interface LedgerSlotV1 {
  admit(request: AdmitRequest): Promise<Admission>;
  started(runId: string, sdkId: string): Promise<void>;
  startFailed(runId: string, error: unknown): Promise<void>;
  refreshRun(runId: string): Promise<LedgerRun | null>;
  reserve(action: ReserveRequest): Promise<Reservation>;
  settle(reservationId: string, actual: { costUsd?: number | null; outcome?: "ok" | "failed" | "blocked"; detail?: Record<string, unknown> }): Promise<void>;
  reconcile(opts?: { force?: boolean }): Promise<{ ran: boolean; linked?: number; external?: number; refreshed?: number; timedOut?: number; settled?: number }>;
  limitsFor(workflow: string): Promise<Limits>;
  getRun(runId: string): Promise<LedgerRun | null>;
  getTree(rootId: string): Promise<LedgerRun[]>;
}

export type SdkRun = {
  sdkRunId: string; workflow: string; status: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string; completedAt: string | null; attributes: Record<string, string>; returnValue?: unknown; error?: string | null;
};
export type CurrentRun = { id: string; rootId: string; trigger: Trigger; preview: boolean; approved: boolean; workflow: string; sdkRunId: string; previewItems: number };

export interface WorkflowsSlotV1 {
  /** The single start path: admit, start, link. */
  start(name: string, input: unknown, meta: Omit<AdmitRequest, "workflow" | "input">): Promise<Admission & { sdkRunId?: string }>;
  getRun(sdkId: string, opts?: { values?: boolean }): Promise<SdkRun | null>;
  listRuns(since: string): Promise<SdkRun[]>;
  currentRun(): Promise<CurrentRun>;
  /** The registry: each workflow's console and ledger settings, by name. */
  registry(): Promise<Record<string, About & RegistryInfo>>;
}

export type Slots = { database: DatabaseSlotV1; ledger: LedgerSlotV1; workflows: WorkflowsSlotV1 };

// ---------------------------------------------------------------- registry

type WorkflowFn = (...args: any[]) => Promise<unknown>;
/** One box of a workflow's diagram: a business step in plain words, not code. */
export type DiagramNode = { id: string; label: string; kind?: "input" | "action" | "decision" | "output"; explanation?: string; details?: Record<string, string | undefined> };
export type Diagram = { nodes: DiagramNode[]; edges: { source: string; target: string; label?: string }[] };
/** What the console shows about a workflow. It never changes how the workflow runs. */
export type About = { description?: string; tables?: string[]; connections?: string[]; diagram?: Diagram };
export type Approval = { required: true; previewItems?: number; previewCalls?: number; previewMaxUsd?: number; previewWithinHours?: number };
export type RegistryInfo = { approval?: Approval; budget?: { perRunUsd?: number; perMonthUsd?: number }; schedule?: { approvedUntil: string; note: string } };
export type RegistryEntry = WorkflowFn | ({ run: WorkflowFn } & About & RegistryInfo);
/** What `workflows/index.ts` exports as `workflows`. */
export type Registry = Record<string, RegistryEntry>;
