import type { Ctx, Manifest, SlotMap } from "../core/types.js";

const INSTANCES = Symbol.for("revbound/slot-instances");

/**
 * `load()`, again for up to 3 s after a ChunkLoadError under next dev: Turbopack keeps a chunk load that raced a rebuild
 * failed until the next edit, so this clears its chunk cache (as Next's hot reloader does) and retries.
 */
export async function loadFresh<T>(load: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await load(); } catch (error) {
      const clear = (globalThis as { __next__clear_chunk_cache__?: unknown }).__next__clear_chunk_cache__;
      if ((error as Error)?.name !== "ChunkLoadError" || typeof clear !== "function" || attempt >= 10) throw error;
      clear();
      await new Promise((done) => setTimeout(done, 300));
    }
  }
}

/**
 * Plugin code's context inside steps and routes, built from the manifest and that plugin's slot map. One instance per
 * slot and manifest in a process, so every caller shares the same provider.
 */
export function context(manifest: Manifest, map: SlotMap): Ctx {
  const g = globalThis as { [INSTANCES]?: WeakMap<Manifest, Map<string, unknown>> };
  const store = (g[INSTANCES] ??= new WeakMap());
  if (!store.has(manifest)) store.set(manifest, new Map());
  const instances = store.get(manifest)!;
  const options = manifest.plugins.find((p) => p.name === map.plugin)?.options ?? {};
  const ctx: Ctx = {
    manifest, plugin: map.plugin, options,
    has: (slot: string) => Object.hasOwn(map.slots, slot),
    get: ((slot: string) => {
      const entry = map.slots[slot];
      if (!entry) throw new Error(`The ${map.plugin} plugin has no "${slot}" slot: add it to its needs or uses, or add a plugin that provides it, then run revbound sync.`);
      const key = `${slot}:${entry.plugin}`;
      if (!instances.has(key)) {
        const provide = entry.provide as { default?: (c: Ctx) => unknown } | ((c: Ctx) => unknown);
        const make = typeof provide === "function" ? provide : provide.default!;
        instances.set(key, make(context(manifest, entry.map.default)));
      }
      return instances.get(key);
    }) as Ctx["get"],
    module: async <T>(name: string) => {
      const load = map.modules[name];
      if (!load) throw new Error(`The ${map.plugin} plugin has no project module "${name}"`);
      return (await loadFresh(load)) as T;
    },
  };
  return ctx;
}
