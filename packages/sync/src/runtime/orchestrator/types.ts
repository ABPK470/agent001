/**
 * Public types for the sync orchestrator submodules.
 *
 * Defined in a leaf module to avoid import cycles between
 * `execute.ts` (consumer) and the helpers it composes.
 *
 * @module
 */

import { SyncProgressKind, type SyncRuntimeHost } from "../../ports/index.js"

export interface ExecuteProgress {
  type: SyncProgressKind
  table?: string
  step?: string
  rowsApplied?: number
  rowsTotal?: number
  message?: string
  error?: string
  deployStatus?: "started" | "done" | "failed" | "skipped"
}

export interface SyncExecuteFailureContext {
  step: string
  table?: string
  op?: string
  cause?: string
}

export class SyncExecuteError extends Error {
  readonly step: string
  readonly table?: string
  readonly op?: string
  readonly causeDetail?: string
  readonly raw: unknown

  constructor(context: SyncExecuteFailureContext, detail: string, raw?: unknown) {
    super(formatSyncExecuteFailure(context, detail))
    this.name = "SyncExecuteError"
    this.step = context.step
    this.table = context.table
    this.op = context.op
    this.causeDetail = context.cause ?? detail
    this.raw = raw
  }
}

export function toSyncExecuteError(error: unknown, fallback: SyncExecuteFailureContext): SyncExecuteError {
  if (error instanceof SyncExecuteError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new SyncExecuteError({ ...fallback, cause: fallback.cause ?? detail }, detail, error)
}

export function formatSyncExecuteFailure(context: SyncExecuteFailureContext, detail: string): string {
  const segments = [context.step]
  if (context.op) segments.push(context.op)
  if (context.table) segments.push(context.table)
  return `${segments.join(" / ")} failed — ${detail}`
}

export interface ExecuteOptions {
  host: SyncRuntimeHost
  confirm: boolean
  /** Resolved MSSQL connector ids — when omitted, probed from host at call site. */
  readyIds?: ReadonlySet<string>
  /** Pool resolver — defaults to adapter getPool when omitted. */
  getPool?: import("../../ports/db-pool.js").DbPoolPort["getPool"]
  /** HTTP client for flow steps — defaults to fetch adapter when omitted. */
  http?: import("../../ports/http.js").HttpPort
  /** Optional progress callback (used by SSE route). */
  onProgress?: (p: ExecuteProgress) => void
  /** Identity of the user requesting execute (for safety rails / audit). */
  userUpn?: string | null
  /**
   * Bypass the entity-registry freeze-window soft block. Off by default;
   * the UI surfaces an explicit "override freeze window" affordance that
   * passes this through. Audited.
   */
  overrideFreezeWindow?: boolean
  /** When aborted (e.g. client closed the SSE stream), stop before further work. */
  signal?: AbortSignal
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Sync execution cancelled")
}

export type SyncExecuteResult =
  | { outcome: "refused"; planId: string; success: false; error: string }
  | {
      outcome: "completed"
      planId: string
      success: boolean
      skipped?: boolean
      message?: string
      error?: string
    }

/** `uspAuditRunCheck` returned status=stop — sync not required (legacy "To sync or not"). */
export class AuditGateSkippedError extends Error {
  readonly step: string

  constructor(step: string, message: string) {
    super(message.trim() || "Synchronization not required.")
    this.name = "AuditGateSkippedError"
    this.step = step
  }
}

export function isAuditGateSkippedError(error: unknown): error is AuditGateSkippedError {
  return error instanceof AuditGateSkippedError
}
