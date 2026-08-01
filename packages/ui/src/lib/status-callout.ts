/**
 * Shared status callout dialect — theme-split soft + border + muted text.
 *
 * Surfaces use `--status-callout-*` tokens:
 *   light → chroma wash on paper (same family as policy softs)
 *   dark  → Factory Reset dialect: quiet `--overlay-2` panel + ~20% chroma
 *            hairline border (not loud soft slabs). Body = muted theme ink.
 *
 * Policy effect cards (ALLOW / DENY) keep `--policy-*-soft` separately.
 * Diffs stay `--diff-*`.
 */

import type { OperationStatus } from "../client/index"

/** Tailwind class bundle for a bordered status wash. */
export type StatusCalloutTone =
  | "ok"
  | "err"
  | "warn"
  | "info"
  | "skip"
  | "muted"

/** Soft fill + thin border; regular muted type (not bold / not chroma ink). */
export const STATUS_CALLOUT: Readonly<Record<StatusCalloutTone, string>> = {
  ok: "bg-status-callout-ok-soft border border-status-callout-ok-border text-text-muted font-normal",
  err: "bg-status-callout-err-soft border border-status-callout-err-border text-text-muted font-normal",
  warn: "bg-status-callout-warn-soft border border-status-callout-warn-border text-text-muted font-normal",
  info: "bg-status-callout-info-soft border border-status-callout-info-border text-text-muted font-normal",
  skip: "bg-overlay-2 border border-dashed border-border text-text-muted font-normal",
  muted: "bg-overlay-2 border border-border-subtle text-text-muted font-normal",
}

/** Compact badge chrome (Pipelines LogStatusLabel) — wash + border; label weight owned by chip. */
export const STATUS_CALLOUT_BADGE: Readonly<Record<StatusCalloutTone, string>> = {
  ok: "border border-status-callout-ok-border bg-status-callout-ok-soft text-text-muted",
  err: "border border-status-callout-err-border bg-status-callout-err-soft text-text-muted",
  warn: "border border-status-callout-warn-border bg-status-callout-warn-soft text-text-muted",
  info: "border border-status-callout-info-border bg-status-callout-info-soft text-text-muted",
  skip: "border border-dashed border-border bg-transparent text-text-muted",
  muted: "border border-border-subtle bg-transparent text-text-muted",
}

export function statusCalloutTone(status: string): StatusCalloutTone {
  switch (status.toLowerCase()) {
    case "success":
    case "succeeded":
    case "completed":
    case "ok":
      return "ok"
    case "failed":
    case "error":
    case "timeout":
      return "err"
    case "cancelled":
    case "canceled":
    case "stopped":
    case "warning":
    case "warn":
      return "warn"
    case "running":
    case "pending":
    case "planning":
    case "waiting":
      return "info"
    case "skipped":
      return "skip"
    default:
      return "muted"
  }
}

export function operationStatusCallout(status: OperationStatus): string {
  return STATUS_CALLOUT[statusCalloutTone(status)]
}

export function operationStatusBadge(status: OperationStatus): string {
  return STATUS_CALLOUT_BADGE[statusCalloutTone(status)]
}
