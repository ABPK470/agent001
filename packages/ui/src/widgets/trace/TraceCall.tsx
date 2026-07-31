/**
 * One LLM call — nested outline (Threads elbows):
 *
 *   Call
 *   ├─ Sent
 *   │   ├─ System / User / …   (messages, one level deeper)
 *   └─ Received
 *       ├─ reply / waiting note
 *       └─ proposed tools
 */

import { ReviewTree, ReviewTreeItem } from "../../components/ReviewTree"
import { fmtTokens, formatMs } from "../../lib/util"
import type { TraceCallNode, TraceCallSearchHit } from "./build-trace-dag"
import { callToolOpenKey, type OpenState } from "./open-state"
import { callReceivedSummary, callSentSummary } from "./trace-format"
import { traceScopeDepth } from "./trace-pin"
import { ExpandableText } from "./TraceExpandable"
import { PromptMessageRow, ToolRow } from "./TraceRows"
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
  const hasTools = call.toolBranches.length > 0

  return (
    <article className={`trace-card${callOpen ? " is-open" : ""}${nested ? " is-nested" : ""}`}>
      <ScopeRow
        scopeId={`call:${call.index}`}
        kind="call"
        callIndex={call.index}
        depth={traceScopeDepth("call", nested)}
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
        <ReviewTree className="trace-card__body">
          <ReviewTreeItem>
            <ScopeRow
              scopeId={`sent:${call.index}`}
              kind="sent"
              callIndex={call.index}
              depth={traceScopeDepth("sent", nested)}
              open={sentOpen}
              onToggle={() => onToggleSent(call.index)}
              leading="Sent"
              summary={callSentSummary(call)}
              soft
            />
            {sentOpen && (
              <ReviewTree className="trace-branch">
                {call.messages.length === 0 ? (
                  <ReviewTreeItem>
                    <span className="trace-empty">No messages recorded</span>
                  </ReviewTreeItem>
                ) : (
                  call.messages.map((msg, mi) => {
                    const key = `${call.index}:m:${mi}`
                    return (
                      <ReviewTreeItem key={key}>
                        <PromptMessageRow
                          scopeId={`message:${key}`}
                          depth={traceScopeDepth("message", nested)}
                          msg={msg}
                          open={openState.messages.has(key)}
                          onToggle={() => onToggleMessage(key)}
                        />
                      </ReviewTreeItem>
                    )
                  })
                )}
              </ReviewTree>
            )}
          </ReviewTreeItem>

          <ReviewTreeItem>
            <ScopeRow
              scopeId={`received:${call.index}`}
              kind="received"
              callIndex={call.index}
              depth={traceScopeDepth("received", nested)}
              open={receivedOpen}
              onToggle={() => onToggleReceived(call.index)}
              leading="Received"
              summary={callReceivedSummary(call)}
              soft
            />
            {receivedOpen && (
              <div className="trace-branch">
                <div className="trace-scope-payload">
                  {call.waiting && <span className="trace-empty">Waiting for reply…</span>}
                  {!call.waiting && call.content && (
                    <ExpandableText text={call.content} className="trace-body-reply" />
                  )}
                  {!call.waiting && !hasTools && !call.content && (
                    <span className="trace-empty is-error">
                      Empty reply — no text and no tool calls
                    </span>
                  )}
                  {call.askedUser && (
                    <p className="trace-note">
                      Waiting on human — answer lands on the next call as User answer.
                    </p>
                  )}
                </div>
                {hasTools ? (
                  <>
                    <div className="trace-scope-payload trace-scope-payload--caption">
                      <div className="trace-branch__caption is-tools">
                        Tool calls
                        <span className="trace-branch__caption-hint">
                          proposed · run in Work below
                        </span>
                      </div>
                    </div>
                    <ReviewTree>
                      {call.toolBranches.map((tc) => {
                        const toolKey = callToolOpenKey(call.index, tc.id)
                        return (
                          <ReviewTreeItem key={tc.id}>
                            <ToolRow
                              tool={tc}
                              open={openState.tools.has(toolKey)}
                              onToggle={() => onToggleTool(toolKey)}
                            />
                          </ReviewTreeItem>
                        )
                      })}
                    </ReviewTree>
                  </>
                ) : null}
              </div>
            )}
          </ReviewTreeItem>
        </ReviewTree>
      )}
    </article>
  )
}
