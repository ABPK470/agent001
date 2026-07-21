/**
 * One LLM call as a bordered card: Call → Sent → Received (+ Next tools).
 *
 * Sticky = native CSS on the real headers. Sent / Received each sit in a
 * .trace-stick-block so leaving that block unsticks the sibling (no clones).
 */

import { fmtTokens, formatMs } from "../../lib/util"
import type { TraceCallNode, TraceCallSearchHit } from "./build-trace-dag"
import type { OpenState } from "./open-state"
import { callReceivedSummary, callSentSummary } from "./trace-format"
import { ExpandableText } from "./TraceExpandable"
import { PromptMessageRow, SqlQualityRow, ToolRow } from "./TraceRows"
import { ScopeRow } from "./TraceScope"

export function CallOutline({
  call,
  openState,
  searchHit,
  onToggleCall,
  onToggleSent,
  onToggleReceived,
  onToggleMessage,
  onToggleTool,
  nested = false,
}: {
  call: TraceCallNode
  openState: OpenState
  searchHit: TraceCallSearchHit | null
  onToggleCall: (index: number) => void
  onToggleSent: (index: number) => void
  onToggleReceived: (index: number) => void
  onToggleMessage: (key: string) => void
  onToggleTool: (id: string) => void
  /** True when this call sits under a step / subagent phase. */
  nested?: boolean
}) {
  const callOpen = openState.calls.has(call.index)
  const sentOpen = openState.sent.has(call.index)
  const receivedOpen = openState.received.has(call.index)
  const usage = call.usage

  return (
    <article className={`trace-card${callOpen ? " is-open" : ""}${nested ? " is-nested" : ""}`}>
      <ScopeRow
        scopeId={`call:${call.index}`}
        kind="call"
        callIndex={call.index}
        depth={nested ? 1 : 0}
        open={callOpen}
        onToggle={() => onToggleCall(call.index)}
        leading={`Call ${call.index + 1}`}
        title={call.headline}
        summary={
          searchHit?.reasons[0]
            ? `matched ${searchHit.reasons[0]}`
            : `iter ${call.iteration + 1}`
        }
        trailing={
          <>
            {usage && (
              <span className="tabular-nums">
                {fmtTokens(usage.promptTokens)}/{fmtTokens(usage.completionTokens)}
              </span>
            )}
            {call.durationMs != null && (
              <span className="tabular-nums">{formatMs(call.durationMs)}</span>
            )}
          </>
        }
      />

      {callOpen && (
        <div className="trace-card__body trace-nest">
          <div className="trace-stick-block">
            <ScopeRow
              scopeId={`sent:${call.index}`}
              kind="sent"
              callIndex={call.index}
              depth={1}
              open={sentOpen}
              onToggle={() => onToggleSent(call.index)}
              leading="Sent"
              summary={callSentSummary(call)}
              soft
            />
            {sentOpen && (
              <div className="trace-scope-body">
                {call.messages.length === 0 ? (
                  <span className="trace-empty">No messages recorded</span>
                ) : (
                  call.messages.map((msg, mi) => {
                    const key = `${call.index}:m:${mi}`
                    return (
                      <PromptMessageRow
                        key={key}
                        msg={msg}
                        open={openState.messages.has(key)}
                        onToggle={() => onToggleMessage(key)}
                      />
                    )
                  })
                )}
              </div>
            )}
          </div>

          <div className="trace-stick-block">
            <ScopeRow
              scopeId={`received:${call.index}`}
              kind="received"
              callIndex={call.index}
              depth={1}
              open={receivedOpen}
              onToggle={() => onToggleReceived(call.index)}
              leading="Received"
              summary={callReceivedSummary(call)}
              soft
            />
            {receivedOpen && (
              <div className="trace-scope-body">
                {call.waiting && <span className="trace-empty">Waiting for reply…</span>}
                {!call.waiting && call.content && (
                  <ExpandableText text={call.content} className="trace-body-reply" />
                )}
                {!call.waiting &&
                  call.toolBranches.length === 0 &&
                  !call.content && (
                    <span className="trace-empty is-error">
                      Empty reply — no text and no tool calls
                    </span>
                  )}
                {call.askedUser && (
                  <p className="trace-note">
                    Waiting on human — answer lands on the next call as User answer.
                  </p>
                )}
                {call.sqlQuality.length > 0 && (
                  <div className="trace-sql-block">
                    <div className="trace-next__label is-sql">
                      SQL check
                      <span className="trace-row__detail">
                        run telemetry · not in the prompt
                      </span>
                    </div>
                    {call.sqlQuality.map((entry, i) => (
                      <SqlQualityRow key={`${entry.toolCallId}-${i}`} entry={entry} />
                    ))}
                  </div>
                )}
                {call.toolBranches.length > 0 && (
                  <div className="trace-next">
                    <div className="trace-next__label is-next">
                      Next
                      <span className="trace-row__detail">
                        {call.toolBranches.length} tool
                        {call.toolBranches.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {call.toolBranches.map((tc) => (
                      <ToolRow
                        key={tc.id}
                        tool={tc}
                        open={openState.tools.has(tc.id)}
                        onToggle={() => onToggleTool(tc.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
