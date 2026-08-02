/**
 * Multi-column metric row for trace master-detail tree.
 */

import { Bot, ChevronRight, Cpu, Layers, Mail, MessageSquare, Reply, Wrench, Zap } from "lucide-react"
import { fmtTokens, formatMs } from "../../lib/util"
import type { TraceTreeNode, TraceTreeNodeKind } from "./trace-tree-index"
import { formatCostUsd } from "./trace-format"
import { TraceTreeStatusBadge } from "./TraceTreeStatusBadge"

const KIND_ICON: Record<TraceTreeNodeKind, typeof Bot> = {
  context: Layers,
  prompt: Cpu,
  tools: Wrench,
  phase: Layers,
  call: Bot,
  sent: Mail,
  received: Reply,
  message: MessageSquare,
  work: Zap,
  tool: Wrench,
}

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
  const Icon = KIND_ICON[node.kind]
  const indent = node.depth * 12
  const tokens =
    node.promptTokens > 0 || node.completionTokens > 0
      ? `${fmtTokens(node.promptTokens)} in / ${fmtTokens(node.completionTokens)} out`
      : "—"

  function onRowClick() {
    onSelect(node.scopeId, false)
  }

  function onChevronClick(event: React.MouseEvent) {
    event.stopPropagation()
    if (node.hasChildren) onToggleFold(node.scopeId)
  }

  return (
    <div
      className={`trace-tree-row${selected ? " is-selected" : ""}${node.branchHasError ? " has-branch-error" : ""}${node.subtitle ? " has-subtitle" : ""}`}
      data-trace-scope={node.scopeId}
      data-trace-kind={node.kind}
      role="treeitem"
      aria-selected={selected}
    >
      <button
        type="button"
        className="trace-tree-row__btn"
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={onRowClick}
      >
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
          <Icon size={14} />
        </span>
        <span className="trace-tree-row__name-col">
          <span className="trace-tree-row__label-cell">
            <TraceTreeStatusBadge
              status={node.status}
              branchHasError={node.branchHasError}
              hasError={node.hasError}
              onJumpToRootCause={() => onJumpToRootCause(node.scopeId)}
            />
            <span className="trace-tree-row__text-group">
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
        </span>
        <span className="trace-tree-row__metric tabular-nums">
          {node.durationMs != null ? formatMs(node.durationMs) : "—"}
        </span>
        <span className="trace-tree-row__metric tabular-nums">{tokens}</span>
        <span className="trace-tree-row__metric tabular-nums">
          {node.costUsd != null ? formatCostUsd(node.costUsd) : "—"}
        </span>
      </button>
    </div>
  )
}

export function traceTreeRowEstimateSize(node: TraceTreeNode | undefined): number {
  if (!node) return 36
  return node.subtitle ? 48 : 36
}
