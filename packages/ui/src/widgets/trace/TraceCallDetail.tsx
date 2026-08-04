/**
 * Call detail — tabs for Input / Raw JSON / Output / System + breakdowns.
 */

import { useMemo, useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { fmtTokens, formatMs } from "../../lib/util"
import type { TraceCallNode, TraceDag } from "./build-trace-dag"
import { TracePayloadStream, TraceMessageCard } from "./TraceMessageCard"
import { TraceExecutionCard } from "./TraceExecutionCard"
import { tokenPairLabel } from "./trace-format"

type DetailTab = "input" | "raw" | "output" | "system"

const TAB_LABELS: { id: DetailTab; label: string }[] = [
  { id: "input", label: "Input Prompt" },
  { id: "raw", label: "Raw JSON" },
  { id: "output", label: "Output" },
  { id: "system", label: "System" },
]

export function TraceCallDetail({
  call,
  dag,
  initialTab = "input",
}: {
  call: TraceCallNode
  dag: TraceDag
  initialTab?: DetailTab
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const systemPrompt =
    call.messages.find((m) => m.role === "system")?.content ??
    dag.preamble.systemPrompt ??
    null
  const userMessages = call.messages.filter((m) => m.role !== "system")

  const rawPayload = useMemo(
    () => ({
      iteration: call.iteration,
      messageCount: call.messageCount,
      toolCount: call.toolCount,
      messages: call.messages,
      content: call.content,
      toolCalls: call.toolBranches,
      usage: call.usage,
      durationMs: call.durationMs,
      model: call.model,
    }),
    [call],
  )

  return (
    <div className="trace-detail-body">
      <div className="trace-detail-tabs" role="tablist">
        {TAB_LABELS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`trace-detail-tab${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="trace-detail-panel" role="tabpanel">
        {tab === "input" && (
          <div className="trace-detail-section">
            {userMessages.length === 0 ? (
              <p className="trace-empty">No user/assistant messages recorded</p>
            ) : (
              <TracePayloadStream messages={userMessages} />
            )}
          </div>
        )}
        {tab === "raw" && (
          <JsonViewer value={rawPayload} copyable embedded inline label="request" />
        )}
        {tab === "output" && (
          <div className="trace-detail-section trace-payload-stream">
            {call.waiting && <p className="trace-empty">Waiting for reply…</p>}
            {!call.waiting && (
              <TraceMessageCard
                role="agent"
                speaker="Agent reply"
                content={call.content}
              />
            )}
            {!call.waiting && call.toolBranches.length > 0 && (
              <div className="trace-detail-tools">
                <div className="trace-detail-section__label">Proposed tools</div>
                {call.toolBranches.map((tool) => (
                  <TraceExecutionCard
                    key={tool.id}
                    toolName={tool.name}
                    argumentsValue={tool.arguments}
                    argsFormatted={tool.argsFormatted}
                    status="proposed"
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "system" && (
          <div className="trace-detail-section trace-payload-stream">
            {systemPrompt ? (
              <TraceMessageCard role="system" speaker="System" content={systemPrompt} />
            ) : (
              <p className="trace-empty">No system prompt</p>
            )}
          </div>
        )}
      </div>

      <div className="trace-detail-breakdowns">
        <section className="trace-detail-breakdown">
          <div className="trace-detail-breakdown__title">Latency breakdown</div>
          <dl className="trace-detail-kv">
            <div>
              <dt>LLM</dt>
              <dd>{call.durationMs != null ? formatMs(call.durationMs) : "—"}</dd>
            </div>
          </dl>
        </section>
        <section className="trace-detail-breakdown">
          <div className="trace-detail-breakdown__title">Token breakdown</div>
          <dl className="trace-detail-kv">
            <div>
              <dt>Input</dt>
              <dd>{call.usage ? fmtTokens(call.usage.promptTokens) : "—"}</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>{call.usage ? fmtTokens(call.usage.completionTokens) : "—"}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>
                {call.usage
                  ? tokenPairLabel(call.usage.promptTokens, call.usage.completionTokens)
                  : "—"}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  )
}
