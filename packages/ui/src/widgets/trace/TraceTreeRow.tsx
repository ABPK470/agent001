/**
 * Multi-column metric row for trace master-detail tree.
 */

import { ChevronRight } from "lucide-react"
import { fmtTokens, formatMs } from "../../lib/util"
import {
  TRACE_TREE_BASE_PAD_PX,
  TRACE_TREE_INDENT_PX,
  traceTreeNodeCellStyle,
} from "./trace-tree-guides"
import { TRACE_KIND_ICON } from "./trace-kind-icon"
import type { TraceTreeNode } from "./trace-tree-index"
import { TraceTreeStatusBadge, TraceTreeStatusDot } from "./TraceTreeStatusBadge"

function displayTitle(node: TraceTreeNode): string {
  return node.leading ? `${node.leading} ${node.name}` : node.name
}

export function TraceTreeRow({
  node,
  selected,
  folded,
  onSelect,
  onToggleFold,
  onJumpToRootCause,
}: {
  node: TraceTreeNode
  selected: boolean
  folded: boolean
  maxDurationMs: number
  onSelect: (scopeId: string, jumpToRootCause?: boolean) => void
  onToggleFold: (scopeId: string) => void
  onJumpToRootCause: (scopeId: string) => void
}) {
  const Icon = TRACE_KIND_ICON[node.kind]
  const tokens =
    node.promptTokens > 0 || node.completionTokens > 0
      ? `${fmtTokens(node.promptTokens)} in / ${fmtTokens(node.completionTokens)} out`
      : "—"
  const showTopLevelBadge = node.depth === 0

  function onRowClick() {
    onSelect(node.scopeId, false)
  }

  function onChevronClick(event: React.MouseEvent) {
    event.stopPropagation()
    if (node.hasChildren) onToggleFold(node.scopeId)
  }

  return (
    <div
      className={[
        "trace-tree-row",
        selected ? "is-selected" : "",
        node.branchHasError ? "has-branch-error" : "",
        node.subtitle ? "has-subtitle" : "",
        node.hasChildren ? "is-branch" : "is-leaf",
        node.depth > 0 ? "is-child" : "is-root",
      ]
        .filter(Boolean)
        .join(" ")}
      data-trace-scope={node.scopeId}
      data-trace-kind={node.kind}
      data-trace-depth={node.depth}
      role="treeitem"
      aria-selected={selected}
    >
      <button type="button" className="trace-tree-row__btn" onClick={onRowClick}>
        <span className="trace-tree-row__node-cell" style={traceTreeNodeCellStyle(node.depth)}>
          {/* Fixed 16px lead column — blank spacer when leaf so icons share one X per depth. */}
          <span className="trace-tree-row__chev" onClick={onChevronClick} aria-hidden>
            {node.hasChildren ? (
              <ChevronRight
                size={13}
                className={`trace-tree-row__chev-icon${folded ? "" : " is-open"}`}
              />
            ) : (
              <span className="trace-tree-row__chev-spacer" />
            )}
          </span>
          <span className="trace-tree-row__icon" aria-hidden>
            {!showTopLevelBadge ? (
              <TraceTreeStatusDot
                status={node.status}
                branchHasError={node.branchHasError}
                hasError={node.hasError}
                onJumpToRootCause={() => onJumpToRootCause(node.scopeId)}
              />
            ) : null}
            <Icon size={14} />
          </span>
          <span className="trace-tree-row__text-block">
            <span className="trace-tree-row__title-stack">
              <span className="trace-tree-row__name" title={displayTitle(node)}>
                {node.leading ? (
                  <>
                    <span className="trace-tree-row__leading">{node.leading}</span>
                    <span className="trace-tree-row__title">{node.name}</span>
                  </>
                ) : (
                  node.name
                )}
              </span>
              {node.subtitle ? (
                <span className="trace-tree-row__subtitle" title={node.subtitle}>
                  {node.subtitle}
                </span>
              ) : null}
            </span>
          </span>
          {showTopLevelBadge ? (
            <TraceTreeStatusBadge
              status={node.status}
              branchHasError={node.branchHasError}
              hasError={node.hasError}
              onJumpToRootCause={() => onJumpToRootCause(node.scopeId)}
            />
          ) : null}
        </span>
        <span className="trace-tree-row__metric trace-tree-row__metric--latency tabular-nums">
          {node.durationMs != null ? formatMs(node.durationMs) : "—"}
        </span>
        <span className="trace-tree-row__metric trace-tree-row__metric--tokens tabular-nums">
          {tokens}
        </span>
      </button>
    </div>
  )
}

export function traceTreeRowEstimateSize(node: TraceTreeNode | undefined): number {
  if (!node) return 44
  return node.subtitle ? 54 : 44
}

export { TRACE_TREE_BASE_PAD_PX, TRACE_TREE_INDENT_PX }
