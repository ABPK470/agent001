/**
 * Call detail — tabs for Input / Raw JSON / Output / System + breakdowns.
 */

import { useMemo, useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { pricingForModel } from "../../lib/events/trace-cost"
import { fmtTokens, formatMs } from "../../lib/util"
import type { TraceCallNode, TraceDag } from "./build-trace-dag"
import { ExpandableText } from "./TraceExpandable"
import { formatCostUsd, tokenPairLabel } from "./trace-format"

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

  const inputCost =
    call.usage && call.model
      ? (call.usage.promptTokens / 1_000_000) * pricingForModel(call.model).inputPer1M
      : null
  const outputCost =
    call.usage && call.model
      ? (call.usage.completionTokens / 1_000_000) * pricingForModel(call.model).outputPer1M
      : null

  const workAfter = useMemo(() => {
    for (const entry of dag.spine) {
      if (entry.kind === "work" && entry.work.afterCallIndex === call.index) {
        return entry.work
      }
      if (entry.kind === "phase") {
        for (const child of entry.phase.children ?? []) {
          if (child.kind === "work" && child.work.afterCallIndex === call.index) {
            return child.work
          }
        }
      }
    }
    return null
  }, [dag.spine, call.index])

  const toolMs =
    workAfter?.sqlQuality.reduce((max, s) => Math.max(max, s.durationMs ?? 0), 0) ?? 0
  const workMs = workAfter?.durationMs ?? (toolMs > 0 ? toolMs : null)
  const totalMs =
    call.durationMs != null
      ? call.durationMs + (workMs ?? 0)
      : workMs

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
              userMessages.map((msg, i) => (
                <div key={`${msg.role}-${i}`} className="trace-detail-message">
                  <div className="trace-detail-message__speaker">{msg.speaker}</div>
                  {msg.content ? (
                    <ExpandableText text={msg.content} className="trace-body-muted" />
                  ) : (
                    <span className="trace-empty">empty</span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
        {tab === "raw" && (
          <JsonViewer value={rawPayload} copyable embedded inline label="request" />
        )}
        {tab === "output" && (
          <div className="trace-detail-section">
            {call.waiting && <p className="trace-empty">Waiting for reply…</p>}
            {!call.waiting && call.content && (
              <ExpandableText text={call.content} className="trace-body-reply" />
            )}
            {!call.waiting && call.toolBranches.length > 0 && (
              <div className="trace-detail-tools">
                <div className="trace-detail-section__label">Proposed tools</div>
                {call.toolBranches.map((tool) => (
                  <JsonViewer
                    key={tool.id}
                    value={tool.arguments}
                    copyable
                    embedded
                    label={tool.name}
                  />
                ))}
              </div>
            )}
            {!call.waiting && !call.content && call.toolBranches.length === 0 && (
              <p className="trace-empty is-error">Empty reply</p>
            )}
          </div>
        )}
        {tab === "system" && (
          <div className="trace-detail-section">
            {systemPrompt ? (
              <ExpandableText text={systemPrompt} className="trace-body-muted" />
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
            <div>
              <dt>Tool / work</dt>
              <dd>{workMs != null ? formatMs(workMs) : "—"}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{totalMs != null ? formatMs(totalMs) : "—"}</dd>
            </div>
          </dl>
        </section>
        <section className="trace-detail-breakdown">
          <div className="trace-detail-breakdown__title">Token cost breakdown</div>
          <dl className="trace-detail-kv">
            <div>
              <dt>Input</dt>
              <dd>
                {call.usage ? fmtTokens(call.usage.promptTokens) : "—"}
                {inputCost != null ? ` · ${formatCostUsd(inputCost)}` : ""}
              </dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>
                {call.usage ? fmtTokens(call.usage.completionTokens) : "—"}
                {outputCost != null ? ` · ${formatCostUsd(outputCost)}` : ""}
              </dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>
                {call.usage
                  ? tokenPairLabel(call.usage.promptTokens, call.usage.completionTokens)
                  : "—"}
                {call.costUsd != null ? ` · ${formatCostUsd(call.costUsd)}` : ""}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  )
}
