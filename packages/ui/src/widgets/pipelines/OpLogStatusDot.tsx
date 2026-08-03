/**
 * Leaf-row status marker — replaces kind/entity icons under pipeline stages.
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

export function OpLogStatusDot({ status }: { status: OperationStatus }) {
  const tone = statusCalloutTone(status)
  return (
    <span
      className={`op-log-status-dot ${DOT_CLASS[tone]}`}
      title={status}
      aria-hidden
    />
  )
}
