/**
 * VS Code-style run diff — system, full sent history, output (+ optional message focus).
 */

import { useMemo, useState } from "react"
import { buildLineTextDiff, type LineDiffRow } from "../../lib/line-text-diff"
import type { TraceDag } from "./build-trace-dag"
import {
  buildCallCompareSnapshot,
  compareCallAvailability,
  resolveCompareCallIndex,
  type CompareRunRow,
} from "./trace-run-compare"
import type { TraceTreeNode } from "./trace-tree-index"

export function TraceRunDiff({
  dag,
  compareDag,
  node,
  compareRunId,
  currentRunId,
  priorRuns,
  onCompareRunChange,
}: {
  dag: TraceDag
  compareDag: TraceDag | null
  node: TraceTreeNode
  compareRunId: string
  currentRunId: string | null
  priorRuns: CompareRunRow[]
  onCompareRunChange: (runId: string) => void
}) {
  const [side, setSide] = useState<"split" | "unified">("split")
  const callIndex = resolveCompareCallIndex(dag, node)

  const currentSnap = useMemo(() => {
    if (callIndex == null) return null
    return buildCallCompareSnapshot(dag, callIndex, node)
  }, [dag, callIndex, node])

  const compareResult = useMemo(() => {
    if (!compareDag || callIndex == null) return { compareSnapshot: null, warning: null as string | null }
    return compareCallAvailability(compareDag, callIndex, node)
  }, [compareDag, callIndex, node])

  if (callIndex == null) {
    return (
      <p className="trace-empty px-2 py-2">This step has no LLM call to compare.</p>
    )
  }

  if (!compareDag) {
    return (
      <p className="trace-empty px-2 py-2">Loading compare run {compareRunId.slice(0, 8)}…</p>
    )
  }

  if (!currentSnap) {
    return <p className="trace-empty px-2 py-2">Call not found in current run.</p>
  }

  const compareSnap = compareResult.compareSnapshot
  const sections: Array<{ title: string; left: string; right: string }> = [
    { title: "System prompt", left: currentSnap.system, right: compareSnap?.system ?? "" },
    { title: "Sent messages", left: currentSnap.sent, right: compareSnap?.sent ?? "" },
    { title: "Output", left: currentSnap.output, right: compareSnap?.output ?? "" },
  ]
  if (currentSnap.selectedMessage) {
    sections.push({
      title: "Selected message",
      left: currentSnap.selectedMessage,
      right: compareSnap?.selectedMessage ?? "",
    })
  }

  return (
    <div className="trace-run-diff">
      <div className="trace-run-diff__toolbar">
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
        {priorRuns.length > 1 ? (
          <label className="trace-run-diff__run-picker">
            <span className="trace-run-diff__run-picker-label">Compare run</span>
            <select
              className="trace-run-diff__run-select"
              value={compareRunId}
              onChange={(e) => onCompareRunChange(e.target.value)}
            >
              {priorRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.id.slice(0, 8)}…
                  {run.createdAt ? ` · ${run.createdAt.slice(0, 10)}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <p className="trace-run-diff__caption">
        {currentSnap.callLabel} — current
        {currentRunId ? ` (${currentRunId.slice(0, 8)}…)` : ""} vs compare (
        {compareRunId.slice(0, 8)}…)
      </p>
      {compareResult.warning ? (
        <p className="trace-run-diff__warning">{compareResult.warning}</p>
      ) : null}
      {sections.map((section) => (
        <DiffSection
          key={section.title}
          title={section.title}
          left={section.left}
          right={section.right}
          mode={side}
        />
      ))}
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
          <SplitDiffPane title="Current" text={left} other={right} />
          <SplitDiffPane title="Compare" text={right} other={left} />
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

function SplitDiffPane({
  title,
  text,
  other,
}: {
  title: string
  text: string
  other: string
}) {
  const lines = text ? text.split("\n") : [""]
  const otherLines = other ? other.split("\n") : [""]
  const max = Math.max(lines.length, otherLines.length)

  return (
    <div className="trace-run-diff-pane">
      <div className="trace-run-diff-pane__title">{title}</div>
      <pre className="trace-run-diff-pane__body">
        {Array.from({ length: max }, (_, i) => {
          const line = lines[i] ?? ""
          const otherLine = otherLines[i] ?? ""
          const differs = line !== otherLine
          return (
            <div
              key={`${i}:${line}`}
              className={`trace-run-diff-line${differs ? " is-changed" : ""}`}
            >
              {line || " "}
            </div>
          )
        })}
      </pre>
    </div>
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
