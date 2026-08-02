/**
 * Inline step playground — edit prompt/input and re-run via server route.
 */

import { useState } from "react"
import { api } from "../../client/index"
import { JsonViewer } from "../../components/JsonViewer"
import type { TraceDag } from "./build-trace-dag"
import type { TraceTreeNode } from "./trace-tree-index"

export function TraceStepPlayground({
  dag,
  node,
  runId,
  onError,
}: {
  dag: TraceDag
  node: TraceTreeNode
  runId: string
  onError?: (message: string) => void
}) {
  const call = node.callIndex != null ? dag.calls[node.callIndex] : null
  const [systemPrompt, setSystemPrompt] = useState(
    () =>
      call?.messages.find((m) => m.role === "system")?.content ??
      dag.preamble.systemPrompt ??
      "",
  )
  const [input, setInput] = useState(
    () => call?.messages.find((m) => m.role === "user")?.content ?? "",
  )
  const [output, setOutput] = useState<string | null>(null)
  const [usage, setUsage] = useState<{
    promptTokens: number
    completionTokens: number
    totalTokens: number
  } | null>(null)
  const [toolCalls, setToolCalls] = useState<
    Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  >([])
  const [running, setRunning] = useState(false)

  async function onRun() {
    setRunning(true)
    setOutput(null)
    setUsage(null)
    setToolCalls([])
    try {
      const result = await api.replayTraceStep(runId, {
        systemPrompt: systemPrompt || null,
        input: input || null,
      })
      setOutput(result.content)
      setUsage(result.usage)
      setToolCalls(result.toolCalls)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Replay failed"
      onError?.(message)
      setOutput(message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="trace-playground">
      <div className="trace-playground__field">
        <label className="trace-playground__label" htmlFor="trace-playground-system">
          System prompt
        </label>
        <textarea
          id="trace-playground-system"
          className="trace-playground__textarea"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={6}
        />
      </div>
      <div className="trace-playground__field">
        <label className="trace-playground__label" htmlFor="trace-playground-input">
          Input
        </label>
        <textarea
          id="trace-playground-input"
          className="trace-playground__textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={8}
        />
      </div>
      <div className="trace-playground__actions">
        <button
          type="button"
          className="trace-detail-action is-primary"
          disabled={running}
          onClick={onRun}
        >
          {running ? "Running…" : "Run step"}
        </button>
      </div>
      {output != null ? (
        <div className="trace-playground__output">
          <div className="trace-detail-section__label">Output</div>
          <pre className="trace-playground__result">{output}</pre>
          {usage ? (
            <p className="trace-playground__usage tabular-nums">
              {usage.promptTokens} in / {usage.completionTokens} out
            </p>
          ) : null}
          {toolCalls.length > 0 ? (
            <JsonViewer value={toolCalls} copyable embedded label="tool calls" />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
