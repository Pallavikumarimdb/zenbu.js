import { Service, runtime } from "../runtime";
import { DbService } from "./db";
import { enqueueRegistrationsWrite } from "./advice-config";
import { createLogger } from "../shared/log";

const log = createLogger("function-registry");

/**
 * Opaque, JSON-serializable metadata attached to a registered function.
 * Surfaced verbatim to the renderer via `core.registrations`; the
 * renderer's `useFunctions` hook uses `meta` to filter \u2014 e.g.
 * `useFunctions({ kind: "cm.completion" })`. Conventions for keys are
 * up to the subsystem that defined the function point.
 */
export type FunctionMeta = Record<string, unknown> & {
  kind?: string;
  label?: string;
};

/**
 * Spec for registering a renderer-side function. The function itself
 * lives in a source file (`modulePath`); the renderer-side reconciler
 * dynamically imports it and pushes the export into the in-renderer
 * `@zenbujs/core/react` function registry under `name`.
 *
 * `modulePath` must be absolute (same convention as
 * `ViewRegistry.register`'s `root` and component-view sources).
 *
 * `exportName` defaults to `"default"`. `meta` is opaque JSON that
 * consumers can filter on via `useFunctions({ kind: "..." })`.
 */
export interface RegisterFunctionSpec {
  name: string;
  modulePath: string;
  exportName?: string;
  meta?: FunctionMeta;
}

/**
 * Server-side registry for renderer functions.
 *
 * The function itself is a runtime value that only exists in the
 * renderer realm; this service just writes a row into
 * `core.registrations` describing *which* module to load and how to
 * apply it. The renderer's reconciler picks it up, dynamic-imports
 * the source, and pushes the export into the in-process function
 * registry that `useFunction` / `useFunctions` read.
 *
 * No prelude codegen, no `emitReload` RPC event. Live add/remove and
 * source-file HMR all flow through the same db patch.
 */
export class FunctionRegistryService extends Service.create({
  key: "functionRegistry",
  deps: { db: DbService },
}) {
  /**
   * Last-write-wins per `name`. Re-registering replaces the existing
   * row in `core.registrations`.
   */
  async register(spec: RegisterFunctionSpec): Promise<void> {
    const { name, modulePath, exportName, meta } = spec;
    log.verbose(
      `register("${name}", modulePath="${modulePath}", export="${exportName ?? "default"}")`,
    );
    await enqueueRegistrationsWrite((root) => {
      const existing = root.core.registrations.findIndex(
        (r: any) => r.kind === "function" && r.name === name,
      );
      const next = {
        kind: "function" as const,
        name,
        modulePath,
        exportName: exportName ?? "default",
        rev: 0,
        meta,
      };
      if (existing >= 0) {
        next.rev = root.core.registrations[existing]!.rev;
        if (root.core.registrations[existing]!.modulePath !== modulePath) {
          next.rev = next.rev + 1;
        }
        root.core.registrations[existing] = next;
      } else {
        root.core.registrations.push(next);
      }
    });
  }

  async unregister(name: string): Promise<void> {
    log.verbose(`unregister("${name}")`);
    await enqueueRegistrationsWrite((root) => {
      const idx = root.core.registrations.findIndex(
        (r: any) => r.kind === "function" && r.name === name,
      );
      if (idx >= 0) root.core.registrations.splice(idx, 1);
    });
  }

  /**
   * Read the current registration for `name`, if any. Sync via
   * `client.readRoot()` \u2014 used by the Vite plugin's
   * `handleHotUpdate` to find which rows to bump on a file change.
   */
  get(name: string) {
    const root = this.ctx.db.client.readRoot();
    return root.core.registrations.find(
      (r) => r.kind === "function" && r.name === name,
    );
  }

  evaluate() {
    this.setup("function-registry-cleanup", () => () => {
      // Drop every function row owned by this process when the service
      // tears down (full restart or hot-reload).
      void enqueueRegistrationsWrite((root) => {
        root.core.registrations = root.core.registrations.filter(
          (r: any) => r.kind !== "function",
        );
      });
    });
  }
}

runtime.register(FunctionRegistryService, import.meta);
