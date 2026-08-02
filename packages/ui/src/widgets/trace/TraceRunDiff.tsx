/**
 * VS Code-style run diff — prompt, input, output with line highlighting.
 */

import { useMemo, useState } from "react"
import { buildLineTextDiff, type LineDiffRow } from "../../lib/line-text-diff"
import type { TraceDag } from "./build-trace-dag"
import type { TraceTreeNode } from "./trace-tree-index"

function callSnapshot(dag: TraceDag, node: TraceTreeNode) {
  const call = node.callIndex != null ? dag.calls[node.callIndex] : null
  return {
    system:
      call?.messages.find((m) => m.role === "system")?.content ??
      dag.preamble.systemPrompt ??
      "",
    input: call?.messages.find((m) => m.role === "user")?.content ?? "",
    output: call?.content ?? "",
  }
}

export function TraceRunDiff({
  dag,
  compareDag,
  node,
  compareRunId,
}: {
  dag: TraceDag
  compareDag: TraceDag | null
  node: TraceTreeNode
  compareRunId: string
}) {
  const [side, setSide] = useState<"split" | "unified">("split")
  const snapA = callSnapshot(dag, node)
  const snapB = compareDag ? callSnapshot(compareDag, node) : { system: "", input: "", output: "" }

  if (!compareDag) {
    return (
      <p className="trace-empty px-2 py-2">Loading previous run {compareRunId}…</p>
    )
  }

  return (
    <div className="trace-run-diff">
      <div className="trace-detail-tabs">
        <button
          type="button"
          className={`trace-detail-tab${side === "split" ? " is-active" : ""}`}
          onClick={() => setSide("split")}
        >
          Side by side
        </button>
        <button
          type="button"
          className={`trace-detail-tab${side === "unified" ? " is-active" : ""}`}
          onClick={() => setSide("unified")}
        >
          Unified
        </button>
      </div>
      <p className="trace-run-diff__caption">
        Current run vs previous ({compareRunId.slice(0, 8)}…)
      </p>
      <DiffSection title="System prompt" left={snapA.system} right={snapB.system} mode={side} />
      <DiffSection title="Input" left={snapA.input} right={snapB.input} mode={side} />
      <DiffSection title="Output" left={snapA.output} right={snapB.output} mode={side} />
    </div>
  )
}

function DiffSection({
  title,
  left,
  right,
  mode,
}: {
  title: string
  left: string
  right: string
  mode: "split" | "unified"
}) {
  const rows = useMemo(() => buildLineTextDiff(left, right), [left, right])
  if (mode === "split") {
    return (
      <section className="trace-run-diff-section">
        <div className="trace-run-diff-section__title">{title}</div>
        <div className="trace-run-diff-split">
          <DiffPane title="Current" text={left} />
          <DiffPane title="Previous" text={right} />
        </div>
      </section>
    )
  }
  return (
    <section className="trace-run-diff-section">
      <div className="trace-run-diff-section__title">{title}</div>
      <UnifiedDiff rows={rows} />
    </section>
  )
}

function UnifiedDiff({ rows }: { rows: LineDiffRow[] }) {
  return (
    <pre className="trace-run-diff-unified-body">
      {rows.map((row, i) => (
        <div
          key={`${row.kind}-${i}`}
          className={`trace-run-diff-line is-${row.kind}`}
        >
          {row.text}
        </div>
      ))}
    </pre>
  )
}

function DiffPane({ title, text }: { title: string; text: string }) {
  return (
    <div className="trace-run-diff-pane">
      <div className="trace-run-diff-pane__title">{title}</div>
      <pre className="trace-run-diff-pane__body">{text || "—"}</pre>
    </div>
  )
}
