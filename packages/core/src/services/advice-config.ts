import path from "node:path"
import * as Effect from "effect/Effect"
import { runtime } from "../runtime"
// NOTE: do NOT import DbService at the top of this module. This file
// is reachable from `services/reloader.ts` through `vite-plugins.ts`,
// and a top-level circular import means the dep class used below
// would resolve to `undefined` during the very first eval pass. We
// resolve `db` lazily inside the few functions that need it (after
// all modules have finished evaluating).

/**
 * Public spec passed to `service.advise({...})`. The plugin root is
 * resolved automatically from the calling service's slot (stamped by
 * `runtime.register` at registration time), so plugin code never has to
 * deal with `import.meta`.
 *
 * `modulePath` is normally relative to the plugin root. Absolute paths
 * are accepted as an escape hatch.
 */
export interface AdviceSpec {
  view: string
  moduleId: string
  name: string
  type: "replace" | "before" | "after" | "around"
  modulePath: string
  exportName: string
}

/**
 * Public spec passed to `service.contentScript({...})`. Same
 * plugin-root resolution rules as `AdviceSpec`.
 */
export interface ContentScriptSpec {
  view: string
  modulePath: string
}

/**
 * Internal entry shape kept around for code that still reads advice
 * synchronously off the in-memory map (e.g. older callers). Phase-3/4
 * code reads from `db.core.registrations` instead.
 */
export interface ViewAdviceEntry {
  moduleId: string
  name: string
  type: "replace" | "before" | "after" | "around"
  modulePath: string
  exportName: string
}

function resolveAgainstPlugin(modulePath: string, pluginDir: string): string {
  if (path.isAbsolute(modulePath)) return modulePath
  return path.resolve(pluginDir, modulePath)
}

/**
 * Resolve the framework's `DbService` instance lazily. The advice +
 * content-script registrars are called inside plugin service
 * `evaluate()` blocks; by that point the runtime has finished
 * resolving service deps and `db` is in the slot table.
 *
 * Returns `undefined` if the slot isn't ready yet (e.g. during boot
 * sequencing); callers fire and forget so missing writes just no-op.
 */
function getDb():
  | {
      effectClient: {
        update: (fn: (root: any) => void) => Effect.Effect<unknown>
      }
      client: { readRoot: () => any }
    }
  | undefined {
  return runtime.getSlot("db")?.instance as any
}

/**
 * fixme: we need to implement queued writes internally in kyju
 */
let writeChain: Promise<void> = Promise.resolve()

/**
 * Public so `FunctionRegistryService` / `ViewRegistryService` /
 * anything else that writes to `core.registrations` can share the
 * same chain. All registrations-table writes from the main process
 * MUST go through here, not through bare `Effect.runPromise`.
 */
export function enqueueRegistrationsWrite(
  build: (root: any) => void,
): Promise<void> {
  const db = getDb()
  if (!db) return Promise.resolve()
  writeChain = writeChain.then(() =>
    Effect.runPromise(db.effectClient.update(build)).then(
      () => {},
      (err) => {
        console.error("[advice-config] write failed:", err)
      },
    ),
  )
  return writeChain
}

function enqueueWrite(build: (root: any) => void): void {
  void enqueueRegistrationsWrite(build)
}

function writeRegistration(
  matcher: (r: any) => boolean,
  next: Record<string, unknown>,
): void {
  enqueueWrite((root) => {
    const idx = root.core.registrations.findIndex(matcher)
    if (idx >= 0) {
      const prev = root.core.registrations[idx]
      const rev =
        prev.modulePath === next.modulePath
          ? prev.rev
          : (prev.rev ?? 0) + 1
      root.core.registrations[idx] = { ...next, rev }
    } else {
      root.core.registrations.push({ ...next, rev: 0 })
    }
  })
}

function removeRegistration(matcher: (r: any) => boolean): void {
  enqueueWrite((root) => {
    const idx = root.core.registrations.findIndex(matcher)
    if (idx >= 0) root.core.registrations.splice(idx, 1)
  })
}

// --- Advice ---

/**
 * Internal advice registrar. Called by `Service#advise` after the
 * runtime has resolved the calling plugin's root directory from its
 * service slot. User code uses `service.advise({...})`.
 *
 * Returns a synchronous dispose that queues the corresponding row's
 * removal from `core.registrations`. The dispose runs from the
 * service `setup()` machinery on plugin teardown / hot reload.
 */
export function addAdvice(pluginDir: string, spec: AdviceSpec): () => void {
  const resolvedPath = resolveAgainstPlugin(spec.modulePath, pluginDir)
  const matcher = (r: any) =>
    r.kind === "advice" &&
    r.view === spec.view &&
    r.moduleId === spec.moduleId &&
    r.name === spec.name &&
    r.adviceType === spec.type &&
    r.modulePath === resolvedPath &&
    r.exportName === spec.exportName

  writeRegistration(matcher, {
    kind: "advice",
    view: spec.view,
    moduleId: spec.moduleId,
    name: spec.name,
    adviceType: spec.type,
    modulePath: resolvedPath,
    exportName: spec.exportName,
  })

  return () => {
    removeRegistration(matcher)
  }
}

// --- Content Scripts ---

/**
 * Internal content-script registrar. Called by
 * `Service#contentScript` after the runtime has resolved the calling
 * plugin's root directory. User code uses
 * `service.contentScript({...})`.
 */
export function addContentScript(
  pluginDir: string,
  spec: ContentScriptSpec,
): () => void {
  const resolvedPath = resolveAgainstPlugin(spec.modulePath, pluginDir)
  const matcher = (r: any) =>
    r.kind === "contentScript" &&
    r.view === spec.view &&
    r.modulePath === resolvedPath

  writeRegistration(matcher, {
    kind: "contentScript",
    view: spec.view,
    modulePath: resolvedPath,
    exportName: "default",
  })

  return () => {
    removeRegistration(matcher)
  }
}

// --- Reads (for the Vite plugin's manifest injection) ---

/**
 * Snapshot the current advice + content-script rows for a renderer
 * about to be served. Filters by view type (mirrors the wildcard
 * semantics — `view: "*"` entries apply to every concrete view).
 *
 * Returns rows in the form the renderer-side bootstrap module
 * expects.
 */
export function readBootstrapManifest(
  viewType: string,
): {
  advice: Array<{
    moduleId: string
    name: string
    adviceType: "replace" | "before" | "after" | "around"
    modulePath: string
    exportName: string
    rev: number
    view: string
  }>
  contentScripts: Array<{ modulePath: string; rev: number; view: string }>
} {
  const db = getDb()
  if (!db) return { advice: [], contentScripts: [] }
  const root = db.client.readRoot()
  const all = (root.core.registrations ?? []) as any[]
  const advice = all
    .filter(
      (r) =>
        r.kind === "advice" && (r.view === viewType || r.view === "*"),
    )
    .map((r) => ({
      moduleId: r.moduleId,
      name: r.name,
      adviceType: r.adviceType,
      modulePath: r.modulePath,
      exportName: r.exportName ?? "default",
      rev: r.rev ?? 0,
      view: r.view,
    }))
  const contentScripts = all
    .filter(
      (r) =>
        r.kind === "contentScript" &&
        (r.view === viewType || r.view === "*"),
    )
    .map((r) => ({ modulePath: r.modulePath, rev: r.rev ?? 0, view: r.view }))
  // Wildcards first so view-scoped advice wraps wildcard advice in
  // the around-chain order (preserves the existing behavior).
  return {
    advice: [
      ...advice.filter((a) => a.view === "*"),
      ...advice.filter((a) => a.view !== "*"),
    ],
    contentScripts: [
      ...contentScripts.filter((c) => c.view === "*"),
      ...contentScripts.filter((c) => c.view !== "*"),
    ],
  }
}
