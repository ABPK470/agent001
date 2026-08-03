/**
 * Activity-row status marker — primary glyph on nested/leaf rows;
 * corner badge on top-level phase icons.
 */

import type { OperationStatus } from "../../client/index"
import { statusCalloutTone } from "../../lib/status-callout"

const DOT_CLASS: Record<ReturnType<typeof statusCalloutTone>, string> = {
  ok: "is-ok",
  err: "is-err",
  warn: "is-warn",
  info: "is-info",
  skip: "is-skip",
  muted: "is-muted",
}

export function OpLogStatusDot({
  status,
  badge = false,
}: {
  status: OperationStatus
  /** Corner micro-dot on a functional phase icon. */
  badge?: boolean
}) {
  const tone = statusCalloutTone(status)
  return (
    <span
      className={`op-log-status-dot ${DOT_CLASS[tone]}${badge ? " is-badge" : ""}`}
      title={status}
      aria-hidden
    />
  )
}
