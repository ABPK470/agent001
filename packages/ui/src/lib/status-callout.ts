/**
 * Shared status callout dialect — soft chroma wash + thin chroma border +
 * chroma text (policies / toasts). Not ink-on-sheet; diffs stay `--diff-*`.
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

/** Soft fill + thin border + text — same family as policy effect chips / toasts. */
export const STATUS_CALLOUT: Readonly<Record<StatusCalloutTone, string>> = {
  ok: "bg-policy-allow-soft border border-policy-allow/35 text-policy-allow",
  err: "bg-policy-deny-soft border border-policy-deny/35 text-policy-deny",
  warn: "bg-policy-approval-soft border border-policy-approval/35 text-policy-approval",
  info: "bg-callout-info-soft border border-callout-info/35 text-callout-info",
  skip: "bg-overlay-2 border border-dashed border-border text-text-muted",
  muted: "bg-overlay-2 border border-border-subtle text-text-muted",
}

/** Compact badge chrome (Pipelines LogStatusLabel). */
export const STATUS_CALLOUT_BADGE: Readonly<Record<StatusCalloutTone, string>> = {
  ok: "border border-policy-allow/35 bg-policy-allow-soft text-policy-allow",
  err: "border border-policy-deny/35 bg-policy-deny-soft text-policy-deny",
  warn: "border border-policy-approval/35 bg-policy-approval-soft text-policy-approval",
  info: "border border-callout-info/35 bg-callout-info-soft text-callout-info",
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
