import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  subscribe as watcherSubscribe,
  type AsyncSubscription,
} from "@parcel/watcher";
import type { WebSocket } from "ws";
import { createDb, type Db, type SectionConfig } from "@zenbu/kyju";
import type {
  KyjuError,
  KyjuMigration,
  EffectFieldNode,
  FieldNode,
} from "@zenbu/kyju";
import type * as Effect from "effect/Effect";
import { createRouter, dbStringify, dbParse } from "@zenbu/kyju/transport";
import { loadMigrationsFromDir } from "@zenbu/kyju/loader";
import { Service, runtime, getPlugins, subscribeConfig } from "../runtime";
import type { ResolvedDbRoot } from "../registry";
import { schema as coreSchema } from "../schema";
import { addDb, resolveDbPath } from "../shared/db-registry";
import { HttpService } from "./http";
import { createLogger } from "../shared/log";

const log = createLogger("db");

/**
 * Walk up from this file's location until we hit the @zenbujs/core
 * package.json. Same trick as `loaders/zenbu.ts` and `vite-plugins.ts`;
 * worth deduping into a shared helper once we have a fourth caller.
 */
async function findCorePackageRoot(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = path.resolve(here, "..", "..");
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    try {
      const parsed = JSON.parse(await fs.readFile(pkg, "utf8"));
      if (parsed.name === "@zenbujs/core") return dir;
    } catch {
      // missing/unparseable package.json on this level — keep climbing
    }
    dir = path.dirname(dir);
  }
  return path.resolve(here, "..", "..");
}

/**
 * Build the core's DB section from the schema in this package + any
 * migrations shipped in `<core>/migrations/`. Loaded via tsx (registered
 * by setup-gate before the runtime services boot), so the source `.ts`
 * files in the published package are imported directly with no extra
 * compile step.
 *
 * If the migrations directory is missing (e.g. before the first
 * `npm run db:generate` runs in the core package), the section degrades
 * to `migrations: []` — same behavior as before this builder existed.
 */
async function buildCoreSection(): Promise<SectionConfig> {
  const corePackageRoot = await findCorePackageRoot();
  const migrationsDir = path.join(corePackageRoot, "migrations");
  let migrations: KyjuMigration[] = [];
  try {
    await fs.access(migrationsDir);
  } catch {
    // Missing dir is allowed: a brand-new core package without
    // `pnpm db:generate` having run yet. Emit an empty section.
    return { name: "core", schema: coreSchema, migrations };
  }
  // Once the dir exists, any load failure (missing file, bad TS, etc.)
  // is a real bug. Loud-fail rather than swallow — swallowing means
  // `sectionMigrationPlugin` sees `targetVersion = 0` and silently
  // leaves the section at its current state, which makes a "my new
  // field is undefined" symptom impossible to attribute.
  migrations = await loadMigrationsFromDir(migrationsDir);
  log.verbose(
    `core section: loaded ${migrations.length} migration(s) from ${migrationsDir}`,
  );
  return { name: "core", schema: coreSchema, migrations };
}

type EffectSectionProxy<S> = {
  [K in keyof S]: EffectFieldNode<S[K]>;
};

type SectionProxy<S> = {
  [K in keyof S]: FieldNode<S[K]>;
};

// `Root` is the resolved DB root: `ZenbuRegister["db"]` from the user's
// generated `zenbu-register.ts`, falling back to `{}` when no plugin has
// augmented the registry. Lets the same baked dts ship with core while
// consumer types flow in via module augmentation. Each top-level key on
// `Root` is a section (e.g. `core`, `app`); section names are the only
// namespace.
type Root = ResolvedDbRoot;

export type SectionedEffectClient = {
  readRoot(): Root;
  update(fn: (root: Root) => void | Root): Effect.Effect<void, KyjuError>;
  createBlob(data: Uint8Array, hot?: boolean): Effect.Effect<string, KyjuError>;
  deleteBlob(blobId: string): Effect.Effect<void, KyjuError>;
  getBlobData(blobId: string): Effect.Effect<Uint8Array | null, KyjuError>;
} & {
  [K in keyof Root]: EffectSectionProxy<Root[K]>;
};

export type SectionedClient = {
  readRoot(): Root;
  update(fn: (root: Root) => void | Root): Promise<void>;
  createBlob(data: Uint8Array, hot?: boolean): Promise<string>;
  deleteBlob(blobId: string): Promise<void>;
  getBlobData(blobId: string): Promise<Uint8Array | null>;
} & {
  [K in keyof Root]: SectionProxy<Root[K]>;
};

export async function resolveManifestModulePath(
  baseDir: string,
  specifier: string,
): Promise<string> {
  const resolved = path.resolve(baseDir, specifier);
  const candidates = path.extname(resolved)
    ? [resolved]
    : [
        resolved,
        `${resolved}.ts`,
        `${resolved}.js`,
        `${resolved}.mjs`,
        path.join(resolved, "index.ts"),
        path.join(resolved, "index.js"),
        path.join(resolved, "index.mjs"),
      ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() || stat.isDirectory()) return candidate;
    } catch {
      // keep trying candidates
    }
  }

  throw new Error(
    `Could not resolve module entry for "${specifier}" from "${baseDir}"`,
  );
}

async function importFreshModule(modulePath: string): Promise<any> {
  // Plain `import()` so dynohot wraps the schema/migrations as live deps of
  // DbService. When these files change, dynohot's file watcher invalidates
  // them and propagates upward via `iterateWithDynamics`; DbService's
  // `runtime.register(..., import.meta)` accept handler re-runs
  // evaluate(), which re-discovers sections and calls createDb with the new
  // migrations array. Kyju's migration plugin then applies only the delta
  // against the existing on-disk DB.
  return import(pathToFileURL(modulePath).href);
}

function resolveConfigPath(): string {
  const fromEnv = process.env.ZENBU_CONFIG_PATH;
  if (!fromEnv) {
    throw new Error(
      "ZENBU_CONFIG_PATH is not set; setup-gate populates this before services boot.",
    );
  }
  return fromEnv;
}

/**
 * Load just the `db` field from the user's `zenbu.config.ts`. Used to feed
 * `resolveDbPath` (which expects a relative-or-absolute string). The full
 * plugin set comes from `runtime.getPlugins()` instead — populated by the
 * loader-emitted barrel before any service evaluates.
 */
async function loadAppDbField(configPath: string): Promise<string> {
  const { loadConfig } = await import("../cli/lib/load-config");
  const { resolved } = await loadConfig(path.dirname(configPath));
  return resolved.dbPath;
}

export async function discoverSections(): Promise<SectionConfig[]> {
  const plugins = getPlugins();

  const perPluginTimings: Array<{
    name: string;
    resolveSchemaMs: number;
    importSchemaMs: number;
    resolveMigrationsMs: number;
    importMigrationsMs: number;
    totalMs: number;
  }> = [];

  // Parallelize two axes:
  //   - Across plugins: all manifests process concurrently (outer Promise.all)
  //   - Within a plugin: schema chain and migrations chain overlap
  const tasks = plugins.map(
    async (plugin): Promise<SectionConfig | null> => {
      const pluginStart = Date.now();
      let resolveSchemaMs = 0;
      let importSchemaMs = 0;
      let resolveMigrationsMs = 0;
      let importMigrationsMs = 0;

      const finish = (result: SectionConfig | null) => {
        perPluginTimings.push({
          name: plugin.name,
          resolveSchemaMs,
          importSchemaMs,
          resolveMigrationsMs,
          importMigrationsMs,
          totalMs: Date.now() - pluginStart,
        });
        return result;
      };

      if (!plugin.schemaPath) return finish(null);

      try {
        const schemaChain = (async () => {
          const s0 = Date.now();
          const schemaPath = await resolveManifestModulePath(
            plugin.dir,
            plugin.schemaPath!,
          );
          resolveSchemaMs = Date.now() - s0;

          const s1 = Date.now();
          const schemaModule = await importFreshModule(schemaPath);
          importSchemaMs = Date.now() - s1;

          return { schemaPath, schemaModule };
        })();

        const migrationsChain = plugin.migrationsPath
          ? (async () => {
              try {
                const m0 = Date.now();
                const migrationsPath = await resolveManifestModulePath(
                  plugin.dir,
                  plugin.migrationsPath!,
                );
                resolveMigrationsMs = Date.now() - m0;

                const m1 = Date.now();
                const stat = await fs.stat(migrationsPath);
                let migrations: KyjuMigration[];
                if (stat.isDirectory()) {
                  migrations = await loadMigrationsFromDir(migrationsPath);
                } else {
                  const migModule = await importFreshModule(migrationsPath);
                  migrations =
                    migModule.migrations ?? migModule.default ?? [];
                }
                importMigrationsMs = Date.now() - m1;

                return { migrations, failed: false as const };
              } catch (error) {
                log.error(
                  `failed to load migrations for plugin "${plugin.name}": ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
                return { migrations: [] as KyjuMigration[], failed: true as const };
              }
            })()
          : Promise.resolve({
              migrations: [] as KyjuMigration[],
              failed: false as const,
            });

        const [schemaResult, migrationsResult] = await Promise.all([
          schemaChain,
          migrationsChain,
        ]);

        if (migrationsResult.failed) return finish(null);

        const schema =
          schemaResult.schemaModule.schema ?? schemaResult.schemaModule.default;
        if (!schema?.shape) {
          log.error(
            `schema module did not export a valid schema: ${schemaResult.schemaPath}`,
          );
          return finish(null);
        }

        return finish({
          name: plugin.name,
          schema,
          migrations: migrationsResult.migrations,
        });
      } catch (error) {
        log.error(
          `failed to load section for plugin "${plugin.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return finish(null);
      }
    },
  );

  const resolvedSections = await Promise.all(tasks);
  const sections: SectionConfig[] = resolvedSections.filter(
    (sec): sec is SectionConfig => sec !== null,
  );

  const sorted = [...perPluginTimings].sort((a, b) => b.totalMs - a.totalMs);
  log.verbose("per-plugin breakdown (ms, parallel):");
  for (const ptm of sorted) {
    log.verbose(
      `  ${ptm.name.padEnd(28)} total=${String(ptm.totalMs).padStart(6)} resS=${String(ptm.resolveSchemaMs).padStart(5)} impS=${String(ptm.importSchemaMs).padStart(6)} resM=${String(ptm.resolveMigrationsMs).padStart(5)} impM=${String(ptm.importMigrationsMs).padStart(6)}`,
    );
  }

  return sections;
}

export class DbService extends Service.create({
  key: "db",
  deps: { http: HttpService },
}) {
  db: Db | null = null;
  dbRouter: ReturnType<typeof createRouter> | null = null;
  private sectionsHash = "";
  private _dbPath: string | null = null;

  /**
   * Resolved DB path. Throws if accessed before `evaluate()` has run — the
   * service contract guarantees deps are evaluated before dependents, so any
   * access from a dependent service or RPC handler is safe.
   */
  get dbPath(): string {
    if (this._dbPath === null) {
      throw new Error("DbService.dbPath accessed before evaluate()");
    }
    return this._dbPath;
  }

  get client(): SectionedClient {
    return this.db!.client as unknown as SectionedClient;
  }

  get effectClient(): SectionedEffectClient {
    return this.db!.effectClient as unknown as SectionedEffectClient;
  }

  /**
   * Drain kyju's lagged-persistence queue. Safe to call anytime; idempotent
   * when nothing is pending. Used by service teardown (effect cleanup) so
   * shutdown / hot-reload don't lose in-memory writes.
   */
  async flush(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.flush();
    } catch (err) {
      log.error("flush failed:", err);
    }
  }

  /**
   * Flush + release the kyju cross-process lock at `<dbPath>/.lock`.
   * Called on service teardown so a subsequent process can open the DB
   * without seeing a stale lock. Idempotent.
   */
  async close(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.close();
    } catch (err) {
      log.error("close failed:", err);
    }
  }

  async evaluate() {
    const configPath = resolveConfigPath();
    const configDir = path.dirname(configPath);
    const configDbAbs = await loadAppDbField(configPath);
    const [coreSec, pluginSections, resolved] = await Promise.all([
      this.trace("build-core-section", () => buildCoreSection()),
      this.trace("discover-sections", () => discoverSections()),
      resolveDbPath(process.argv, {
        configDb: configDbAbs,
        configDir,
        configPath,
      }),
    ]);
    const sections = [coreSec, ...pluginSections];
    const sectionsHash = JSON.stringify(
      sections.map((s) => ({ name: s.name, v: s.migrations.length })),
    );
    const dbPath = resolved.path;

    if (
      !this.db ||
      this.sectionsHash !== sectionsHash ||
      this._dbPath !== dbPath
    ) {
      // If we're replacing an existing Db (sectionsHash or path changed
      // mid-process), close the old one first so it flushes and releases
      // its lock-file nonce. Without this, the abandoned Db would still
      // have its `process.on("exit")` handler attached and could
      // unintentionally release the lock the new instance is about to
      // acquire (or vice versa).
      if (this.db) {
        try {
          await this.db.close();
        } catch (err) {
          log.error("close of previous db failed:", err);
        }
      }
      this.dbRouter = createRouter();
      this.db = await this.trace("create-db", () =>
        createDb({
          sections,
          path: dbPath,
          send: (event) => this.dbRouter!.send(event),
        }),
      );
      this.sectionsHash = sectionsHash;
      this._dbPath = dbPath;
      addDb(dbPath).catch((err) => {
        log.error("failed to bump registry lastUsedAt:", err);
      });
      log.verbose(
        `ready at ${dbPath} (source: ${resolved.source}, sections: ${sections
          .map((s) => `${s.name}@v${s.migrations.length}`)
          .join(", ")})`,
      );
    }

    const { http } = this.ctx;
    const wsDbConnections = new Map<
      string,
      { receive: (event: any) => Promise<void>; close: () => void }
    >();

    // On any teardown (hot-reload OR shutdown), drain kyju's lagged
    // writes AND release the cross-process lock. Without `close()`, in-
    // memory writes that haven't reached setImmediate's flush would
    // vanish, AND the next process attempting to open this DB would
    // either be blocked by a stale lock or (in the same-process re-init
    // case) would race against the abandoned writer.
    this.setup("kyju-close-on-cleanup", () => async () => {
      await this.close();
    });

    // Watch each plugin's migrations directory so `zen db generate` —
    // which writes a fresh file plus updates `meta/_journal.json` — kicks
    // DbService into a re-evaluate. Edits to *existing* migration files
    // are already covered by dynohot's per-file dep tracking; we only
    // care about adds/removes here, plus journal churn (which fires on
    // every generate even when paths look unchanged due to atomic
    // rename-replace writes).
    this.setup("migrations-watcher", () => {
      const subs: AsyncSubscription[] = [];
      let closed = false;
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      let inFlight: Promise<void> | null = null;
      let queued = false;

      const triggerReload = async () => {
        if (closed) return;
        if (inFlight) {
          queued = true;
          return;
        }
        inFlight = runtime.reload("db").catch((err) => {
          log.error("migrations-watcher reload failed:", err);
        });
        try {
          await inFlight;
        } finally {
          inFlight = null;
          if (queued && !closed) {
            queued = false;
            scheduleReload();
          }
        }
      };

      const scheduleReload = () => {
        if (closed) return;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          void triggerReload();
        }, 100);
      };

      void (async () => {
        for (const plugin of getPlugins()) {
          const migPath = plugin.migrationsPath;
          if (!migPath) continue;
          let isDir = false;
          try {
            isDir = (await fs.stat(migPath)).isDirectory();
          } catch {
            // Missing dir is fine — plugin hasn't generated migrations
            // yet. The first generate creates the dir; the next time
            // DbService re-evaluates (e.g. on a schema edit) this
            // watcher gets installed.
            continue;
          }
          if (!isDir) continue;

          const journalPath = path.join(migPath, "meta", "_journal.json");

          try {
            const sub = await watcherSubscribe(migPath, (err, events) => {
              if (err || closed) return;
              for (const event of events) {
                if (event.path === journalPath) {
                  scheduleReload();
                  return;
                }
                if (path.dirname(event.path) !== migPath) continue;
                if (event.type === "update") continue;
                const ext = path.extname(event.path);
                if (ext === ".ts" || ext === ".js" || ext === ".mjs") {
                  scheduleReload();
                  return;
                }
              }
            });
            if (closed) {
              await sub.unsubscribe().catch(() => {});
              return;
            }
            subs.push(sub);
          } catch (err) {
            log.error(
              `migrations-watcher subscribe failed for ${plugin.name}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      })().catch((err) => {
        log.error("migrations-watcher setup failed:", err);
      });

      return async () => {
        closed = true;
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        const toClose = subs.splice(0);
        await Promise.all(
          toClose.map((s) => s.unsubscribe().catch(() => {})),
        );
      };
    });

    // Pick up plugin-set changes from `zenbu.config.ts` (a plugin
    // added, removed, or its schema/migrations paths swapped). The
    // plugin barrel auto-re-imports new plugins' service files via
    // dynohot, but DbService doesn't have an ESM dep on the plugin
    // registry — `discoverSections` reads `getPlugins()` at evaluate-
    // time only. Without this watcher, a freshly added plugin's
    // schema/migrations would never be wired into the DB until some
    // other change (e.g. editing an existing schema file) happened to
    // trigger a DbService re-evaluate.
    //
    // Hash on `{ name, schemaPath, migrationsPath }` so we react to
    // both adds/removes and to a plugin pointing at a different
    // schema/migrations path. Initial subscribe fires synchronously
    // with the current snapshot — the hash dedup makes that a no-op.
    this.setup("plugin-set-watcher", () => {
      const fingerprint = (snap: { plugins: Array<{ name: string; schemaPath?: string; migrationsPath?: string }> }) =>
        JSON.stringify(
          [...snap.plugins]
            .map((p) => ({
              name: p.name,
              schemaPath: p.schemaPath ?? null,
              migrationsPath: p.migrationsPath ?? null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      let lastHash: string | null = null;
      return subscribeConfig((snap) => {
        const hash = fingerprint(snap);
        if (lastHash === null) {
          lastHash = hash;
          return;
        }
        if (hash === lastHash) return;
        lastHash = hash;
        void runtime.reload("db").catch((err) => {
          log.error("plugin-set-watcher reload failed:", err);
        });
      });
    });

    this.setup("ws-transport", () => {
      const onConnected = (id: string, ws: WebSocket) => {
        const dbConn = this.dbRouter!.connection({
          send: (event: any) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(dbStringify({ ch: "db", data: event }));
            }
          },
          postMessage: this.db!.postMessage,
        });
        wsDbConnections.set(id, dbConn);

        ws.on("message", async (raw: Buffer) => {
          const msg = dbParse(String(raw));
          if (msg.ch === "db") {
            await dbConn.receive(msg.data);
          }
        });
      };

      const onDisconnected = (id: string) => {
        const conn = wsDbConnections.get(id);
        if (conn) {
          conn.close();
          wsDbConnections.delete(id);
        }
      };

      const unsubConnected = http.onConnected(onConnected);
      const unsubDisconnected = http.onDisconnected(onDisconnected);

      for (const [id, ws] of http.activeConnections) {
        onConnected(id, ws);
      }

      return () => {
        unsubConnected();
        unsubDisconnected();
        for (const conn of wsDbConnections.values()) conn.close();
        wsDbConnections.clear();
      };
    });
  }
}

runtime.register(DbService, import.meta);
