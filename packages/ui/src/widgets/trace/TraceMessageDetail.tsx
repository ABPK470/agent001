/**
 * Message row detail — single prompt message body.
 */

import { JsonViewer } from "../../components/JsonViewer"
import type { TraceCallNode } from "./build-trace-dag"
import { ExpandableText } from "./TraceExpandable"

export function TraceMessageDetail({
  call,
  messageKey,
}: {
  call: TraceCallNode
  messageKey: string
}) {
  const mi = Number(messageKey.split(":m:")[1])
  const msg = call.messages[mi]
  if (!msg) return <p className="trace-empty">Message not found</p>

  return (
    <div className="trace-detail-body">
      <div className="trace-detail-section">
        <div className="trace-detail-section__label">{msg.speaker}</div>
        {msg.content ? (
          <ExpandableText text={msg.content} className="trace-body-muted" />
        ) : (
          <span className="trace-empty">empty</span>
        )}
      </div>
      {msg.toolCalls.length > 0 ? (
        <div className="trace-detail-section">
          <div className="trace-detail-section__label">Tool calls in message</div>
          <JsonViewer value={msg.toolCalls} copyable embedded inline />
        </div>
      ) : null}
    </div>
  )
}
