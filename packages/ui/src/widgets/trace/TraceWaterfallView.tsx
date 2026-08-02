/**
 * Waterfall timeline — parallel Gantt bars for subagents / calls.
 */

import { formatMs } from "../../lib/util"
import type { TraceTreeIndex, TraceTreeNode } from "./trace-tree-index"

export function TraceWaterfallView({
  treeIndex,
  selectedScopeId,
  onSelect,
}: {
  treeIndex: TraceTreeIndex
  selectedScopeId: string | null
  onSelect: (scopeId: string) => void
}) {
  const bars = treeIndex.nodes.filter(
    (n) =>
      (n.kind === "call" || n.kind === "phase" || n.kind === "work") &&
      n.durationMs != null &&
      n.durationMs > 0,
  )
  const runMax =
    bars.reduce((max, b) => Math.max(max, b.startOffsetMs + (b.durationMs ?? 0)), 0) || 1

  function barWidth(node: TraceTreeNode): number {
    if (node.durationMs == null) return 0
    return Math.max(2, (node.durationMs / runMax) * 100)
  }

  function barLeft(node: TraceTreeNode): number {
    return (node.startOffsetMs / runMax) * 100
  }

  return (
    <div className="trace-waterfall" role="list">
      {bars.length === 0 ? (
        <p className="trace-empty px-2 py-3">No timed spans yet</p>
      ) : (
        bars.map((node) => (
          <button
            key={node.scopeId}
            type="button"
            className={`trace-waterfall-row${selectedScopeId === node.scopeId ? " is-selected" : ""}${node.status === "failed" ? " is-error" : ""}`}
            onClick={() => onSelect(node.scopeId)}
          >
            <span className="trace-waterfall-row__label" title={node.name}>
              {node.leading ? `${node.leading}: ${node.name}` : node.name}
            </span>
            <span className="trace-waterfall-row__track">
              <span
                className="trace-waterfall-row__bar"
                style={{
                  marginLeft: `${barLeft(node)}%`,
                  width: `${barWidth(node)}%`,
                }}
              />
            </span>
            <span className="trace-waterfall-row__duration tabular-nums">
              {node.durationMs != null ? formatMs(node.durationMs) : "—"}
            </span>
          </button>
        ))
      )}
    </div>
  )
}
