/**
 * Event Stream detail drawer — Datadog-style right inspector.
 * Mounted on the LiveLogs shell when the tile is wide enough (≥640px).
 */

import { X } from "lucide-react"
import type { LogEntry } from "../../types"
import { JsonViewer } from "../../components/JsonViewer"
import { formatEventStreamRowTime } from "../../lib/event-stream-time"
import { eventStreamTypeClass, type EventStreamEventType } from "../../lib/event-stream-lane"
import { isSyncSqlEventType } from "../sync/trace/sync-sql-trace"
import { SqlTraceFromEventData } from "../sync/trace/SqlTrace"

export function EventStreamDetailDrawer({
  open,
  log,
  onClose,
  compact,
}: {
  open: boolean
  log: LogEntry | null
  onClose: () => void
  compact: boolean
}) {
  if (!log) return null

  const lane = log.type as EventStreamEventType
  const isError = Boolean(log.error)

  return (
    <aside
      className="event-stream-drawer"
      data-open={open ? "true" : "false"}
      role="dialog"
      aria-modal="false"
      aria-label="Event detail"
    >
      <header className="event-stream-drawer__head">
        <div className="event-stream-drawer__meta">
          <span className={["event-stream-row__type", eventStreamTypeClass(lane)].join(" ")}>
            {lane}
          </span>
          {log.eventName ? (
            <span className="event-stream-drawer__title" title={log.eventName}>
              {log.eventName}
            </span>
          ) : null}
          <span className="event-stream-drawer__time" title={log.timestamp}>
            {formatEventStreamRowTime(log.timestamp, { tiny: false })}
          </span>
        </div>
        <button
          type="button"
          className="toolbar-ops-btn toolbar-ops-btn--danger shrink-0"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close (Esc)"
        >
          <X size={14} aria-hidden />
        </button>
      </header>

      <div className="event-stream-drawer__body">
        {log.message ? (
          <p
            className={[
              "event-stream-drawer__message",
              isError ? "event-stream-drawer__message--err" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {log.message}
          </p>
        ) : null}

        {log.data ? (
          <div
            className={
              isError
                ? "event-stream-payload__box event-stream-payload__box--err"
                : "event-stream-payload__box"
            }
          >
            {log.eventName && isSyncSqlEventType(log.eventName) ? (
              <SqlTraceFromEventData
                data={log.data}
                compact
                maxHeight={compact ? 160 : 220}
              />
            ) : null}
            <JsonViewer
              value={log.data}
              label="payload"
              defaultExpandDepth={2}
              maxHeight={compact ? 320 : 480}
            />
          </div>
        ) : (
          <p className="event-stream-drawer__empty">No payload for this event.</p>
        )}
      </div>
    </aside>
  )
}
