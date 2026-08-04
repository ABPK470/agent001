/**
 * Call detail — System → Input → Output | Raw JSON + breakdowns.
 *
 * Chronological LLM inspection: what the model saw first (system), then the
 * conversation turn, then what it returned. Raw JSON is a meta view on the right.
 */

import { useEffect, useMemo, useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { fmtTokens, formatMs } from "../../lib/util"
import type { TraceCallNode, TraceDag } from "./build-trace-dag"
import { TracePayloadStream, TraceMessageCard } from "./TraceMessageCard"
import { TraceExecutionCard } from "./TraceExecutionCard"
import { SystemPromptStack } from "./TraceSystemPrompt"
import { callConversationMessages, tokenPairLabel } from "./trace-format"

export type CallDetailTab = "system" | "input" | "output" | "raw"

const PRIMARY_TABS: { id: CallDetailTab; label: string }[] = [
  { id: "system", label: "System" },
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
]

const META_TAB: { id: CallDetailTab; label: string } = {
  id: "raw",
  label: "Raw JSON",
}

export function TraceCallDetail({
  call,
  dag,
  initialTab = "output",
}: {
  call: TraceCallNode
  dag: TraceDag
  initialTab?: CallDetailTab
}) {
  const [tab, setTab] = useState<CallDetailTab>(initialTab)

  // Selection Call → Sent → Received reuses this component; follow the
  // tree node's intended pane (useState only honors initialTab on mount).
  useEffect(() => {
    setTab(initialTab)
  }, [initialTab, call.index])

  const systemMessages = (() => {
    const prompts =
      dag.preamble.systemPrompts.length > 0
        ? dag.preamble.systemPrompts
        : dag.preamble.systemPrompt
          ? [dag.preamble.systemPrompt]
          : []
    const fromCall = call.messages.filter((m) => m.role === "system" && m.content?.trim())
    // Prefer every preamble `system-prompt` when the call only carries the first
    // (or omits them) — Call System must not hide later prompts.
    if (prompts.length > fromCall.length) {
      return prompts.map((content) => ({ role: "system" as const, content }))
    }
    if (fromCall.length > 0) return fromCall
    return prompts.map((content) => ({ role: "system" as const, content }))
  })()

  // Input = conversation turn only; system lives on the System tab.
  const conversation = callConversationMessages(call)

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
        {PRIMARY_TABS.map((t) => (
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
        <span className="trace-detail-tabs__sep" aria-hidden />
        <button
          type="button"
          role="tab"
          aria-selected={tab === META_TAB.id}
          className={`trace-detail-tab trace-detail-tab--meta${tab === META_TAB.id ? " is-active" : ""}`}
          onClick={() => setTab(META_TAB.id)}
        >
          {META_TAB.label}
        </button>
      </div>

      <div className="trace-detail-panel" role="tabpanel">
        {tab === "system" && (
          <SystemPromptStack
            prompts={systemMessages
              .map((m) => m.content?.trim() ?? "")
              .filter(Boolean)}
            labelFor={(i, total) => (total > 1 ? `System ${i + 1}` : "System")}
          />
        )}
        {tab === "input" && (
          <div className="trace-detail-section">
            {conversation.length === 0 ? (
              <p className="trace-empty">No conversation messages recorded</p>
            ) : (
              <TracePayloadStream messages={conversation} />
            )}
          </div>
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
        {tab === "raw" && (
          <JsonViewer value={rawPayload} copyable embedded inline label="request" />
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
