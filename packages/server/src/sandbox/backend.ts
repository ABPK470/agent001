/**
 * SandboxBackend abstraction (Phase 1 milestone 3 of hosted-MIA plan).
 *
 * The hosted execution profile must keep the same behavioral contract on
 * Windows, Linux, and macOS, with Docker as an optional parity backend.
 * This module defines the pluggable interface and ships two implementations:
 *
 *   - SandboxBackendKind.Host   : cross-platform Node child_process backend that always runs
 *                inside an isolated sandbox directory. This is the default
 *                hosted backend on Windows, Linux, and macOS deployments
 *                where Docker is not available.
 *   - SandboxBackendKind.Docker : optional containerized backend that wraps the existing
 *                {@link DockerSandbox}. Preserved for deployments where
 *                Docker is available and stronger isolation is desired.
 *
 * Backend parity contract:
 *   - Every backend creates / accepts an explicit sandbox root path that
 *     lives outside the application source tree.
 *   - Every backend starts shell commands in that sandbox root.
 *   - Every backend canonicalizes paths before execution so symlink and
 *     traversal escapes do not silently land in real workspace state.
 *   - Backend selection is explicit (env or config), never inferred from
 *     the OS at call sites.
 *
 * Phases 2+ will route filesystem and shell tools through the active
 * backend, evaluate selector-based policy decisions on the canonicalized
 * command/path, and audit the matched rule per call.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { resolve, sep } from "node:path"
import { SandboxBackendKind } from "../enums/sandbox.js"
import { getSandbox } from "./index.js"
import type { SandboxResult } from "./types.js"

/**
 * Hard cap on captured stdout/stderr. Mirrors the legacy `execFile`
 * default and prevents a runaway tool call from buffering gigabytes
 * before write-time compaction has a chance to trim it.
 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

/**
 * Network env vars proactively cleared when a command runs with
 * `network: false`. We can't actually firewall outbound traffic from
 * inside the Node process — that's the deployment's responsibility
 * (firewall / WFP / iptables) — but we can stop tools from picking up
 * proxy hints that would otherwise punch a hole through the deny.
 * The policy engine remains the authoritative gate; this is defense
 * in depth, not the boundary.
 */
const NETWORK_ENV_VARS_TO_STRIP = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "GIT_PROXY_COMMAND", "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY",
] as const

export { SandboxBackendKind }

export interface SandboxExecOptions {
  /** Hard cap in milliseconds. */
  timeout?:    number
  /** Sub-path relative to the sandbox root. Must stay inside sandboxRoot. */
  cwd?:        string
  /** Allowlist of environment variables to forward. Backend may filter. */
  env?:        Record<string, string>
  /** Whether outbound network is allowed for this command. Default: false. */
  network?:    boolean
  /** Cancellation signal. */
  signal?:     AbortSignal
}

export interface SandboxBackend {
  readonly kind: SandboxBackendKind
  /** Whether the backend is usable in the current process/host. */
  available(): Promise<boolean>
  /**
   * Execute a shell command rooted at `sandboxRoot`. Implementations MUST:
   *   - canonicalize `sandboxRoot` and any `cwd` before spawning,
   *   - reject any cwd that escapes `sandboxRoot`,
   *   - default network to deny when `options.network` is unset/false,
   *   - never inherit the parent process working directory implicitly.
   */
  exec(command: string, sandboxRoot: string, options?: SandboxExecOptions): Promise<SandboxResult>
}

// ── Helpers ────────────────────────────────────────────────────────

function resolveCwd(sandboxRoot: string, sub?: string): string {
  const root = resolve(sandboxRoot)
  if (!sub || sub.length === 0) return root
  const candidate = resolve(root, sub)
  // Disallow traversal outside the sandbox root.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`sandbox cwd escapes sandbox root: ${sub}`)
  }
  return candidate
}

// ── Host backend (cross-platform Node child_process) ─────────────────

class HostSandboxBackend implements SandboxBackend {
  readonly kind = SandboxBackendKind.Host

  async available(): Promise<boolean> {
    return true
  }

  async exec(command: string, sandboxRoot: string, options: SandboxExecOptions = {}): Promise<SandboxResult> {
    const cwd = resolveCwd(sandboxRoot, options.cwd)
    const timeout = options.timeout ?? 30_000

    // Cross-platform shell. On POSIX we put the child in its own process
    // group (`detached: true`) so a timeout kill (or the caller's
    // AbortSignal) takes the whole tree, not just the top-level shell —
    // a rogue `bash -c "while true; do …; done"` used to survive
    // `execFile`'s SIGTERM and orphan its descendants. On Windows we use
    // `taskkill /F /T /PID` for the same effect since Job Objects aren't
    // exposed via the Node API and `detached` doesn't form a kill-group.
    //
    // Network restrictions are still primarily the policy engine's job;
    // here we strip proxy/cred env vars when the caller did not opt into
    // network so tools can't stealthily route around a deny.
    const isWindows = process.platform === "win32"
    const file = isWindows ? (process.env["COMSPEC"] ?? "cmd.exe") : "/bin/sh"
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command]

    const env = buildChildEnv(options.env, options.network === true)

    return await new Promise<SandboxResult>((resolvePromise) => {
      let child: ChildProcess
      try {
        child = spawn(file, args, {
          cwd,
          env,
          windowsHide: true,
          // POSIX only — Windows ignores this and we kill via taskkill.
          detached:    !isWindows,
          stdio:       ["ignore", "pipe", "pipe"],
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        resolvePromise({
          stdout:    "",
          stderr:    `failed to spawn shell: ${msg}`,
          exitCode:  1,
          timedOut:  false,
          sandboxed: false,
        })
        return
      }

      let stdout = ""
      let stderr = ""
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let timedOut = false
      let settled = false
      let timeoutEscalation: NodeJS.Timeout | null = null

      const collect = (which: "stdout" | "stderr") => (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
        if (which === "stdout") {
          if (stdoutBytes >= MAX_OUTPUT_BYTES) { truncated = true; return }
          stdoutBytes += Buffer.byteLength(text, "utf8")
          stdout += text
        } else {
          if (stderrBytes >= MAX_OUTPUT_BYTES) { truncated = true; return }
          stderrBytes += Buffer.byteLength(text, "utf8")
          stderr += text
        }
      }
      child.stdout?.on("data", collect("stdout"))
      child.stderr?.on("data", collect("stderr"))

      const killTree = (signal: NodeJS.Signals = "SIGTERM"): void => {
        if (child.pid === undefined) return
        if (isWindows) {
          // Best-effort tree kill on Windows. Synchronous so the timeout
          // path doesn't race the close handler.
          try { spawnSync("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true }) }
          catch { /* fall through to child.kill below */ }
        } else {
          // POSIX: negative pid → process group kill.
          try { process.kill(-child.pid, signal) } catch { /* ignore ESRCH */ }
        }
        try { child.kill(signal) } catch { /* ignore */ }
      }

      const timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        killTree("SIGTERM")
        // Escalate even if the top-level shell exits quickly: descendants can
        // outlive the shell, so the group kill must not depend on `close`.
        timeoutEscalation = setTimeout(() => {
          killTree("SIGKILL")
          timeoutEscalation = null
        }, 250)
        timeoutEscalation.unref()
      }, timeout)
      timer.unref()

      const onAbort = (): void => {
        if (settled) return
        killTree("SIGTERM")
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })

      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (timeoutEscalation) {
          clearTimeout(timeoutEscalation)
          timeoutEscalation = null
        }
        options.signal?.removeEventListener("abort", onAbort)
        const trailer = truncated ? `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : ""
        resolvePromise({
          stdout:    stdout + (truncated ? trailer : ""),
          stderr,
          exitCode,
          timedOut,
          sandboxed: false,
        })
      }

      child.on("error", (err) => {
        stderr += `\n${err.message}`
        finish(1)
      })
      child.on("close", (code, signal) => {
        const exitCode = typeof code === "number"
          ? code
          : signal
            ? 128 + (typeof signal === "string" ? 15 : 0)
            : 1
        finish(exitCode)
      })
    })
  }
}

/**
 * Compose the child env. When the caller did not opt into network, we
 * proactively strip well-known proxy / credential hints so tools can't
 * stealthily route around a deny via env-driven proxies.
 */
function buildChildEnv(
  override: Record<string, string> | undefined,
  network: boolean,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = override
    ? { ...sanitizeEnv(override) }
    : { ...process.env }
  if (!network) {
    for (const key of NETWORK_ENV_VARS_TO_STRIP) delete base[key]
  }
  return base
}

function sanitizeEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

// ── Docker backend (wraps existing DockerSandbox) ────────────────────

class DockerSandboxBackend implements SandboxBackend {
  readonly kind = SandboxBackendKind.Docker

  async available(): Promise<boolean> {
    return getSandbox().isDockerAvailable()
  }

  async exec(command: string, sandboxRoot: string, options: SandboxExecOptions = {}): Promise<SandboxResult> {
    return getSandbox().exec(command, sandboxRoot, options)
  }
}

// ── Selection ────────────────────────────────────────────────────────

let _hostBackend: SandboxBackend | null = null
let _dockerBackend: SandboxBackend | null = null

export function getSandboxBackend(kind: SandboxBackendKind): SandboxBackend {
  if (kind === SandboxBackendKind.Docker) {
    if (!_dockerBackend) _dockerBackend = new DockerSandboxBackend()
    return _dockerBackend
  }
  if (!_hostBackend) _hostBackend = new HostSandboxBackend()
  return _hostBackend
}

/**
 * Resolve the configured sandbox backend kind.
 *
 *   AGENT_SANDBOX_BACKEND=host   → cross-platform host backend (default).
 *   AGENT_SANDBOX_BACKEND=docker → docker backend (only honored if Docker
 *                                  is actually available; otherwise the
 *                                  caller decides whether to fall back).
 *
 * Selection is explicit and never inferred from the OS — Windows, Linux,
 * and macOS hosted deployments all use the host backend by default.
 */
export function resolveSandboxBackendKind(): SandboxBackendKind {
  const raw = (process.env["AGENT_SANDBOX_BACKEND"] ?? SandboxBackendKind.Host).toLowerCase()
  return raw === SandboxBackendKind.Docker ? SandboxBackendKind.Docker : SandboxBackendKind.Host
}
