/**
 * Shared status notice dialect — left stroke, clean background.
 *
 * Surfaces use semantic stroke colors (success / error / warning / info).
 * Toasts keep `--status-callout-*-soft` separately (`.mia-toast`).
 * Policy effect cards keep `--policy-*-soft`. Diffs stay `--diff-*`.
 */

import type { OperationStatus } from "../client/index"

/** Tailwind class bundle for a status notice block. */
export type StatusCalloutTone =
  | "ok"
  | "err"
  | "warn"
  | "info"
  | "skip"
  | "muted"

const STROKE =
  "border border-border-subtle border-l-[3px] bg-transparent text-text-muted font-normal"

/** Left-stroke notice — no soft fill. */
export const STATUS_CALLOUT: Readonly<Record<StatusCalloutTone, string>> = {
  ok: `${STROKE} border-l-success`,
  err: `${STROKE} border-l-error`,
  warn: `${STROKE} border-l-warning`,
  info: `${STROKE} border-l-info`,
  skip: "border border-dashed border-border bg-transparent text-text-muted font-normal",
  muted: "border border-border-subtle bg-transparent text-text-muted font-normal",
}

/** Compact badge / filter chip — stroke only on err/warn/ok/info. */
export const STATUS_CALLOUT_BADGE: Readonly<Record<StatusCalloutTone, string>> = {
  ok: "border border-border-subtle border-l-[3px] border-l-success bg-transparent text-text-muted",
  err: "border border-border-subtle border-l-[3px] border-l-error bg-transparent text-text-muted",
  warn: "border border-border-subtle border-l-[3px] border-l-warning bg-transparent text-text-muted",
  info: "border border-border-subtle border-l-[3px] border-l-info bg-transparent text-text-muted",
  skip: "border border-dashed border-border bg-transparent text-text-muted",
  muted: "border border-border-subtle bg-transparent text-text-muted",
}

/** Dense list row — left stroke only (event stream, pipelines). */
export const STATUS_ROW_STROKE: Readonly<Record<StatusCalloutTone, string>> = {
  ok: "mia-row-stroke mia-row-stroke--ok",
  err: "mia-row-stroke mia-row-stroke--err",
  warn: "mia-row-stroke mia-row-stroke--warn",
  info: "mia-row-stroke mia-row-stroke--info",
  skip: "mia-row-stroke",
  muted: "mia-row-stroke",
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

export function operationStatusRowStroke(status: OperationStatus): string {
  return STATUS_ROW_STROKE[statusCalloutTone(status)]
}
