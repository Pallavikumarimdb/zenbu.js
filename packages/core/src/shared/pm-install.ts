/**
 * Bundled-toolchain `<pm> install` helpers.
 *
 * Imported by both:
 *   - `packages/core/src/launcher.ts` (tsdown inlines this into
 *     `dist/launcher.mjs`; the launcher cannot `import "@zenbujs/core"`)
 *   - `packages/core/src/services/updater.ts` (resolved through normal
 *     `@zenbujs/core/...` resolution at runtime)
 *
 * Both call sites operate on the apps-dir (`~/.zenbu/apps/<name>/`) and
 * the .app's `Resources/` (where `provisionToolchain` staged
 * `bun`, `pnpm`, etc.). The launcher kicks off the FIRST install at
 * launch; the updater service runs the SAME logic when an `update()`
 * lockfile-diff says deps drifted.
 */

import crypto from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawnWithInstallHangGuard } from "../install-guard"

export type PackageManagerSpec =
  | { type: "pnpm"; version: string }
  | { type: "npm"; version: string }
  | { type: "yarn"; version: string }
  | { type: "bun"; version: string }

export type InstallStepId = "clone" | "fetch" | "install" | "handoff" | "resolve"

export interface InstallProgress {
  phase?: string
  loaded?: number
  total?: number
  ratio?: number
}

export interface InstallReporter {
  step?(id: InstallStepId, label: string): void
  message?(text: string): void
  progress?(payload: InstallProgress): void
  done?(id: InstallStepId): void
  error?(payload: { id?: InstallStepId; message: string }): void
  /** Optional sink for the raw `<pm> install` stdout/stderr lines. */
  rawLine?(stream: "stdout" | "stderr", line: string): void
}

export function lockfileFor(type: PackageManagerSpec["type"]): string {
  switch (type) {
    case "pnpm":
      return "pnpm-lock.yaml"
    case "npm":
      return "package-lock.json"
    case "yarn":
      return "yarn.lock"
    case "bun":
      return "bun.lock"
  }
}

export function isYarnBerry(version: string): boolean {
  const major = parseInt(version.split(".")[0] ?? "", 10)
  return Number.isFinite(major) && major >= 2
}

export function bundledToolPath(name: string, resourcesPath: string): string | null {
  const candidates = [
    path.join(resourcesPath, "toolchain", "bin", name),
    path.join(resourcesPath, "toolchain", name),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolve the entrypoint we'll exec for a given PM, mirroring the layout
 * `provisionToolchain` writes into the bundle's `Resources/toolchain/`.
 */
export function bundledPmEntry(pm: PackageManagerSpec, resourcesPath: string):
  | { kind: "bin"; path: string }
  | { kind: "js"; path: string }
  | { kind: "bun" } {
  switch (pm.type) {
    case "pnpm": {
      const p = path.join(
        resourcesPath,
        "toolchain",
        "pnpm",
        "bin",
        "pnpm.cjs",
      )
      if (!existsSync(p)) {
        throw new Error(
          `bundled pnpm entry not found at ${p}. The .app's toolchain is incomplete.`,
        )
      }
      return { kind: "js", path: p }
    }
    case "npm": {
      const p = path.join(resourcesPath, "toolchain", "npm", "bin", "npm-cli.js")
      if (!existsSync(p)) {
        throw new Error(
          `bundled npm entry not found at ${p}. The .app's toolchain is incomplete.`,
        )
      }
      return { kind: "js", path: p }
    }
    case "yarn": {
      if (isYarnBerry(pm.version)) {
        const p = path.join(resourcesPath, "toolchain", "yarn.cjs")
        if (!existsSync(p)) {
          throw new Error(
            `bundled yarn (berry) entry not found at ${p}. The .app's toolchain is incomplete.`,
          )
        }
        return { kind: "js", path: p }
      }
      const p = path.join(resourcesPath, "toolchain", "yarn", "bin", "yarn.js")
      if (!existsSync(p)) {
        throw new Error(
          `bundled yarn (classic) entry not found at ${p}. The .app's toolchain is incomplete.`,
        )
      }
      return { kind: "js", path: p }
    }
    case "bun":
      return { kind: "bun" }
  }
}

export function electronTargetVersion(appsDir: string): string {
  if (process.versions.electron) return process.versions.electron
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(appsDir, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const version =
      pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? ""
    return version.replace(/^[^\d]*/, "") || "42.0.0"
  } catch {
    return "42.0.0"
  }
}


export function buildInstallEnv(
  appsDir: string,
  resourcesPath?: string,
): NodeJS.ProcessEnv {
  const target = electronTargetVersion(appsDir)
  const sep = process.platform === "win32" ? ";" : ":"
  const baselinePath = process.env.PATH ?? process.env.Path ?? ""
  const toolchainDir = resourcesPath
    ? path.join(resourcesPath, "toolchain")
    : null
  const systemDirs =
    process.platform === "win32"
      ? []
      // not needed stupid remove
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  const segments: string[] = []
  if (toolchainDir) segments.push(toolchainDir)
  if (baselinePath) segments.push(...baselinePath.split(sep))
  segments.push(...systemDirs)
  const seen = new Set<string>()
  const PATH = segments
    .filter((s) => s && !seen.has(s) && seen.add(s))
    .join(sep)
  return {
    ...process.env,
    PATH,
    // Windows env lookup is case-insensitive but Node preserves the
    // original casing; setting both keeps behavior consistent across
    // platforms.
    Path: PATH,
    CI: "true",
    HOME: path.join(appsDir, ".zenbu", ".node-gyp"),
    npm_config_runtime: "electron",
    npm_config_target: target,
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_arch: process.arch,
  }
}

/**
 * Best-effort progress regex per package manager. We pass each stdout line
 * through these and return a `progress` payload when one matches; otherwise
 * `null`. Failing to match is fine — the UI just won't show fine-grained
 * progress for that PM.
 */
const PNPM_RESOLVED_RE = /Progress:\s+resolved\s+(\d+),\s+reused\s+(\d+),\s+downloaded\s+(\d+)/i
const PNPM_PROGRESS_RE = /(\d+)\s*\/\s*(\d+)/

export function parseInstallProgress(
  pm: PackageManagerSpec["type"],
  line: string,
): InstallProgress | null {
  if (pm === "pnpm") {
    const m = line.match(PNPM_RESOLVED_RE)
    if (m) {
      const resolved = parseInt(m[1]!, 10)
      const reused = parseInt(m[2]!, 10)
      const downloaded = parseInt(m[3]!, 10)
      return {
        phase: "resolve",
        loaded: reused + downloaded,
        total: resolved,
        ratio: resolved > 0 ? (reused + downloaded) / resolved : undefined,
      }
    }
  }
  const m = line.match(PNPM_PROGRESS_RE)
  if (m) {
    const loaded = parseInt(m[1]!, 10)
    const total = parseInt(m[2]!, 10)
    if (total > 0) return { loaded, total, ratio: loaded / total }
  }
  return null
}

function spawnInstall(args: {
  bin: string
  cliArgs: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  label: string
  pmType: PackageManagerSpec["type"]
  reporter: InstallReporter | null
  signal?: AbortSignal
}): Promise<void> {
  const { bin, cliArgs, cwd, env, label, pmType, reporter, signal } = args
  // Delegate the actual spawn + hang-detection + incident-logging to
  // the generic `install-guard` helper. Reporter-specific glue stays
  // here: it translates per-line callbacks into `reporter.message` /
  // `reporter.progress` events.
  return spawnWithInstallHangGuard({
    bin,
    args: cliArgs,
    cwd,
    env,
    pmType,
    label,
    signal,
    passthroughIfUnobserved: true,
    onRawLine: reporter
      ? (rawLine, which) => reporter.rawLine?.(which, rawLine)
      : undefined,
    onLine: reporter
      ? (line) => {
          reporter.message?.(line)
          const progress = parseInstallProgress(pmType, line)
          if (progress) reporter.progress?.(progress)
        }
      : undefined,
  }).then(() => undefined)
}

export interface RunInstallOptions {
  appsDir: string
  resourcesPath: string
  pm: PackageManagerSpec
  reporter?: InstallReporter | null
  signal?: AbortSignal
}

export async function runInstall(opts: RunInstallOptions): Promise<void> {
  const { appsDir, resourcesPath, pm, reporter = null, signal } = opts
  const env = buildInstallEnv(appsDir, resourcesPath)
  const entry = bundledPmEntry(pm, resourcesPath)

  switch (pm.type) {
    case "pnpm": {
      // Run pnpm.cjs through bundled bun so all pnpm versions work
      // (the npm-registry tarball is integrity-verified at build time;
      // the standalone GitHub binary only carries attestation digests
      // for recent releases).
      if (entry.kind !== "js") throw new Error("internal: pnpm entry shape")
      const bun = bundledToolPath("bun", resourcesPath)
      if (!bun) {
        throw new Error(
          `bundled bun not found in ${resourcesPath}/toolchain (required to host the pnpm.cjs entry)`,
        )
      }
      await spawnInstall({
        bin: bun,
        cliArgs: [entry.path, "install", "--reporter=append-only"],
        cwd: appsDir,
        env,
        label: "pnpm install",
        pmType: pm.type,
        reporter,
        signal,
      })
      return
    }
    case "npm": {
      if (entry.kind !== "js") throw new Error("internal: npm entry shape")
      const bun = bundledToolPath("bun", resourcesPath)
      if (!bun) {
        throw new Error(
          `bundled bun not found in ${resourcesPath}/toolchain (required to host the npm-cli.js entry)`,
        )
      }
      await spawnInstall({
        bin: bun,
        cliArgs: [entry.path, "install", "--no-audit", "--no-fund", "--no-progress"],
        cwd: appsDir,
        env,
        label: "npm install",
        pmType: pm.type,
        reporter,
        signal,
      })
      return
    }
    case "yarn": {
      if (entry.kind !== "js") throw new Error("internal: yarn entry shape")
      const bun = bundledToolPath("bun", resourcesPath)
      if (!bun) {
        throw new Error(
          `bundled bun not found in ${resourcesPath}/toolchain (required to host the yarn.js entry)`,
        )
      }
      if (isYarnBerry(pm.version)) {
        // Berry: `--immutable=false` is invalid syntax — toggle via env so
        // we don't fail on lockfile drift at first launch.
        await spawnInstall({
          bin: bun,
          cliArgs: [entry.path, "install"],
          cwd: appsDir,
          env: { ...env, YARN_ENABLE_IMMUTABLE_INSTALLS: "false" },
          label: `yarn install (${pm.version})`,
          pmType: pm.type,
          reporter,
          signal,
        })
      } else {
        // Classic (yarn 1.x): bun's https response object doesn't expose
        // `socket.authorized`, which yarn 1.x checks unconditionally when
        // strictSSL is true; the check throws "does not support SSL" even
        // though the actual TLS handshake succeeded. Workaround: hand
        // yarn a tiny `.yarnrc` that turns strictSSL off — the underlying
        // TLS connection is still encrypted. We point at an external file
        // (NOT the source tree) so we don't pollute the user's repo.
        const rcPath = path.join(
          appsDir,
          ".zenbu",
          "yarn-classic-bun.yarnrc",
        )
        await fsp.mkdir(path.dirname(rcPath), { recursive: true })
        await fsp.writeFile(rcPath, "strict-ssl false\n")
        await spawnInstall({
          bin: bun,
          cliArgs: [
            entry.path,
            "install",
            "--non-interactive",
            "--no-progress",
            "--network-timeout",
            "600000",
            "--use-yarnrc",
            rcPath,
            "--registry",
            "https://registry.npmjs.org/",
          ],
          cwd: appsDir,
          env,
          label: `yarn install (${pm.version})`,
          pmType: pm.type,
          reporter,
          signal,
        })
      }
      return
    }
    case "bun": {
      const bun = bundledToolPath("bun", resourcesPath)
      if (!bun) {
        throw new Error(
          `bundled bun not found in ${resourcesPath}/toolchain. The .app is missing required toolchain binaries.`,
        )
      }
      await spawnInstall({
        bin: bun,
        cliArgs: ["install", "--no-progress"],
        cwd: appsDir,
        env,
        label: "bun install",
        pmType: pm.type,
        reporter,
        signal,
      })
      return
    }
  }
}

async function fileHash(hash: crypto.Hash, filePath: string): Promise<void> {
  hash.update(filePath)
  hash.update("\0")
  try {
    hash.update(await fsp.readFile(filePath))
  } catch {}
  hash.update("\0")
}

export async function depsSignature(
  appsDir: string,
  pm: PackageManagerSpec,
): Promise<string> {
  const hash = crypto.createHash("sha256")
  await fileHash(hash, path.join(appsDir, "package.json"))
  await fileHash(hash, path.join(appsDir, lockfileFor(pm.type)))
  hash.update(`${pm.type}@${pm.version}`)
  hash.update("\0")
  hash.update(process.versions.electron ?? "no-electron")
  hash.update("\0")
  hash.update(process.platform)
  hash.update("\0")
  hash.update(process.arch)
  return hash.digest("hex")
}

/**
 * Read `<appsDir>/.zenbu/deps-sig` (the signature recorded after the
 * last successful install). Returns `null` when missing.
 */
export async function readDepsSig(appsDir: string): Promise<string | null> {
  const sigPath = path.join(appsDir, ".zenbu", "deps-sig")
  try {
    return await fsp.readFile(sigPath, "utf8")
  } catch {
    return null
  }
}

export async function writeDepsSig(appsDir: string, sig: string): Promise<void> {
  const sigPath = path.join(appsDir, ".zenbu", "deps-sig")
  await fsp.mkdir(path.dirname(sigPath), { recursive: true })
  await fsp.writeFile(sigPath, sig)
}
