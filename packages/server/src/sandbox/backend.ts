/**
 * SandboxBackend abstraction (Phase 1 milestone 3 of hosted-MIA plan).
 *
 * The hosted execution profile must keep the same behavioral contract on
 * Windows, Linux, and macOS, with Docker as an optional parity backend.
 * This module defines the pluggable interface and ships two implementations:
 *
 *   - "host"   : cross-platform Node child_process backend that always runs
 *                inside an isolated sandbox directory. This is the default
 *                hosted backend on Windows, Linux, and macOS deployments
 *                where Docker is not available.
 *   - "docker" : optional containerized backend that wraps the existing
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

import { execFile } from "node:child_process"
import { resolve, sep } from "node:path"
import { promisify } from "node:util"
import { getSandbox } from "./index.js"
import type { SandboxResult } from "./types.js"

const exec = promisify(execFile)

export type SandboxBackendKind = "host" | "docker"

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
  readonly kind = "host" as const

  async available(): Promise<boolean> {
    return true
  }

  async exec(command: string, sandboxRoot: string, options: SandboxExecOptions = {}): Promise<SandboxResult> {
    const cwd = resolveCwd(sandboxRoot, options.cwd)
    const timeout = options.timeout ?? 30_000

    // Cross-platform shell: rely on the user's default shell. On Windows this
    // is cmd/powershell depending on COMSPEC; on Linux/macOS this is /bin/sh.
    // Backend-level network restrictions are not enforced here — that is the
    // responsibility of the policy engine (Phase 2) and OS-level network
    // controls. We do, however, refuse to inherit the parent cwd by always
    // pinning to the sandbox root.
    const isWindows = process.platform === "win32"
    const file = isWindows ? (process.env["COMSPEC"] ?? "cmd.exe") : "/bin/sh"
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command]

    try {
      const { stdout, stderr } = await exec(file, args, {
        cwd,
        timeout,
        env:        sanitizeEnv(options.env),
        signal:     options.signal,
        maxBuffer:  10 * 1024 * 1024,
        windowsHide: true,
      })
      return {
        stdout:    String(stdout ?? ""),
        stderr:    String(stderr ?? ""),
        exitCode:  0,
        timedOut:  false,
        sandboxed: false,
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean; signal?: string }
      const timedOut = e.killed === true && (e.signal === "SIGTERM" || e.code === "ETIMEDOUT")
      return {
        stdout:    String(e.stdout ?? ""),
        stderr:    String(e.stderr ?? e.message ?? ""),
        exitCode:  typeof e.code === "number" ? e.code : 1,
        timedOut,
        sandboxed: false,
      }
    }
  }
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
  readonly kind = "docker" as const

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
  if (kind === "docker") {
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
  const raw = (process.env["AGENT_SANDBOX_BACKEND"] ?? "host").toLowerCase()
  return raw === "docker" ? "docker" : "host"
}
