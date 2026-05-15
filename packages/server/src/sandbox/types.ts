// ── Types ────────────────────────────────────────────────────────
import type { WorkspaceMountMode } from "../enums/sandbox.js"
/** Sandbox configuration — matches agenc-core's SandboxConfig shape. */
export interface SandboxConfig {
  /**
   * Execution mode:
   *   "all"    — Docker is MANDATORY. Commands fail if Docker is unavailable.
   *   "docker" — Use Docker if available, fall back to host if not.
   *   "host"   — Always run on host (for development/debugging only).
   */
  mode?: "all" | "docker" | "host"
  /** Docker image to use. Default: node:20-slim */
  image?: string
  /** Memory limit per container. Default: "4g" */
  maxMemory?: string
  /** CPU limit per container. Default: "2.0" */
  maxCpu?: string
  /** Maximum concurrent containers. Default: 4 */
  maxConcurrent?: number
  /** Kill containers idle longer than this (ms). Default: 1_800_000 (30 min) */
  idleTimeoutMs?: number
  /** Hard cap on any single container's lifetime (ms). Default: 300_000 (5 min) */
  maxLifetimeMs?: number
  /**
   * Workspace mount mode inside the container.
   *   "readwrite" — full read/write (shell sandbox default)
   *   "readonly"  — read-only mount (browser sandbox default)
   *   "none"      — workspace not mounted at all
   */
  workspaceAccess?: WorkspaceMountMode
  /** Command timeout in ms. Default: 30_000 */
  timeout?: number
  /** Allow network access inside container. Default: false */
  network?: boolean
}

/** Result from a sandboxed execution. */
export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /** Whether execution ran in Docker or fell back to host. */
  sandboxed: boolean
}

/** Tracked container metadata for the watchdog. */
export interface TrackedContainer {
  startedAt: number
  lastActivityAt: number
}
