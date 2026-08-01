/**
 * Shared status callout dialect — soft chroma wash + thin chroma border +
 * regular theme text. Chroma carries meaning on the surface; ink stays readable.
 * Diffs stay `--diff-*`. Policy effect labels (ALLOW / DENY) keep chroma text.
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
  ok: "bg-policy-allow-soft border border-policy-allow/35 text-text-muted font-normal",
  err: "bg-policy-deny-soft border border-policy-deny/35 text-text-muted font-normal",
  warn: "bg-policy-approval-soft border border-policy-approval/35 text-text-muted font-normal",
  info: "bg-callout-info-soft border border-callout-info/35 text-text-muted font-normal",
  skip: "bg-overlay-2 border border-dashed border-border text-text-muted font-normal",
  muted: "bg-overlay-2 border border-border-subtle text-text-muted font-normal",
}

/** Compact badge chrome (Pipelines LogStatusLabel) — wash + border; label weight owned by chip. */
export const STATUS_CALLOUT_BADGE: Readonly<Record<StatusCalloutTone, string>> = {
  ok: "border border-policy-allow/35 bg-policy-allow-soft text-text-muted",
  err: "border border-policy-deny/35 bg-policy-deny-soft text-text-muted",
  warn: "border border-policy-approval/35 bg-policy-approval-soft text-text-muted",
  info: "border border-callout-info/35 bg-callout-info-soft text-text-muted",
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
