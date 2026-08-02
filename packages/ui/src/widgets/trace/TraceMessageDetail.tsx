/**
 * Message row detail — single prompt message in a structured card.
 */

import { JsonViewer } from "../../components/JsonViewer"
import type { TraceCallNode } from "./build-trace-dag"
import { TraceMessageCardFromPrompt } from "./TraceMessageCard"

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
      <div className="trace-payload-stream">
        <TraceMessageCardFromPrompt msg={msg} />
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
