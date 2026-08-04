/**
 * Waterfall timeline — parallel Gantt bars for subagents / calls.
 * Labels match tree dialect: kind icon + unique name (no "Work:" / "Subagent:" text burn).
 */

import { formatMs } from "../../lib/util"
import { TRACE_KIND_ICON } from "./trace-kind-icon"
import type { TraceTreeIndex, TraceTreeNode } from "./trace-tree-index"

/** Kind words the icon already teaches — keep ordinals like "Call 1". */
const REDUNDANT_LEADING = new Set([
  "Work",
  "Tool",
  "Subagent",
  "Phase",
  "Prompt",
  "Tools",
  "Context",
])

function waterfallVisibleLeading(node: TraceTreeNode): string | null {
  if (!node.leading) return null
  if (REDUNDANT_LEADING.has(node.leading)) return null
  return node.leading
}

function waterfallTooltip(node: TraceTreeNode): string {
  const title = node.leading ? `${node.leading} ${node.name}` : node.name
  const duration = node.durationMs != null ? formatMs(node.durationMs) : null
  return [title, duration, node.status].filter(Boolean).join(" · ")
}

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
        bars.map((node) => {
          const Icon = TRACE_KIND_ICON[node.kind]
          const leading = waterfallVisibleLeading(node)
          return (
            <button
              key={node.scopeId}
              type="button"
              className={`trace-waterfall-row${selectedScopeId === node.scopeId ? " is-selected" : ""}${node.status === "failed" ? " is-error" : ""}`}
              onClick={() => onSelect(node.scopeId)}
              title={waterfallTooltip(node)}
            >
              <span className="trace-waterfall-row__label">
                <span className="trace-waterfall-row__icon" aria-hidden>
                  <Icon size={12} />
                </span>
                <span className="trace-waterfall-row__text">
                  {leading ? (
                    <span className="trace-waterfall-row__leading">{leading}</span>
                  ) : null}
                  <span className="trace-waterfall-row__name">{node.name}</span>
                </span>
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
          )
        })
      )}
    </div>
  )
}
