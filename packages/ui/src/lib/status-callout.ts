/**
 * Shared status notice dialect — theme-split in CSS.
 *
 * Dark: left stroke, clean background (`.mia-callout`, `.mia-row-stroke`).
 * Light: soft row/card washes + chunky pills (`.mia-status-pill`) for scan speed.
 * Toasts keep `--status-callout-*-soft` separately (`.mia-toast`).
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

/** Inline notice — dark stroke; light wash via CSS override. */
export const STATUS_CALLOUT: Readonly<Record<StatusCalloutTone, string>> = {
  ok: `${STROKE} border-l-success`,
  err: `${STROKE} border-l-error`,
  warn: `${STROKE} border-l-warning`,
  info: `${STROKE} border-l-info`,
  skip: "border border-dashed border-border bg-transparent text-text-muted font-normal",
  muted: "border border-border-subtle bg-transparent text-text-muted font-normal",
}

/** Chunky scan pill — event stream, trace badges, pipeline labels. */
export const STATUS_PILL: Readonly<Record<StatusCalloutTone, string>> = {
  ok: "mia-status-pill mia-status-pill--ok",
  err: "mia-status-pill mia-status-pill--err",
  warn: "mia-status-pill mia-status-pill--warn",
  info: "mia-status-pill mia-status-pill--info",
  skip: "mia-status-pill border border-dashed border-border bg-transparent text-text-muted",
  muted: "mia-status-pill border border-border-subtle bg-transparent text-text-muted",
}

/** @deprecated Prefer STATUS_PILL — kept for call-site compat. */
export const STATUS_CALLOUT_BADGE: Readonly<Record<StatusCalloutTone, string>> = STATUS_PILL

/** Dense list row — dark left stroke; light full-row wash via CSS. */
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
    case "validated":
      return "ok"
    case "failed":
    case "error":
    case "timeout":
    case "crashed":
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

export function operationStatusPill(status: OperationStatus | string): string {
  return STATUS_PILL[statusCalloutTone(status)]
}

/** @deprecated Prefer operationStatusPill. */
export function operationStatusBadge(status: OperationStatus): string {
  return operationStatusPill(status)
}

export function operationStatusRowStroke(status: OperationStatus): string {
  return STATUS_ROW_STROKE[statusCalloutTone(status)]
}
