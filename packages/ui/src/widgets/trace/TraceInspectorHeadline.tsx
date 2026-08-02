/**
 * Inspector header — node-type title, status badge, metrics.
 */

import { formatMs } from "../../lib/util"
import type { TraceTreeNode } from "./trace-tree-index"
import { TraceTreeStatusBadge } from "./TraceTreeStatusBadge"
import { formatCostUsd, tokenPairLabel } from "./trace-format"

export function inspectorTitle(node: TraceTreeNode): string {
  switch (node.kind) {
    case "tool":
      return `Tool: ${node.name}`
    case "work":
      return node.toolKey ? `Tool: ${node.name}` : `Work: ${node.name}`
    case "call":
      return node.subtitle ?? node.name
    case "phase":
      return node.leading ? `${node.leading} ${node.name}` : node.name
    case "sent":
      return "Sent messages"
    case "received":
      return "Received reply"
    case "message":
      return node.name
    case "context":
      return "Context"
    case "prompt":
      return "System prompt"
    case "tools":
      return "Resolved tools"
    default:
      return node.name
  }
}

function inspectorMetrics(node: TraceTreeNode): string[] {
  const bits: string[] = []
  if (node.durationMs != null) bits.push(formatMs(node.durationMs))
  if (node.costUsd != null) bits.push(formatCostUsd(node.costUsd))
  if (node.promptTokens > 0 || node.completionTokens > 0) {
    bits.push(tokenPairLabel(node.promptTokens, node.completionTokens))
  }
  return bits
}

function inspectorSubtitle(node: TraceTreeNode): string | null {
  if (!node.subtitle) return null
  if (node.kind === "call") return null
  return node.subtitle
}

export function TraceInspectorHeadline({ node }: { node: TraceTreeNode }) {
  const metrics = inspectorMetrics(node)
  const subtitle = inspectorSubtitle(node)

  return (
    <div className="trace-detail__headline">
      <div className="trace-detail__headline-row">
        <span className="trace-detail__headline-title">{inspectorTitle(node)}</span>
        <TraceTreeStatusBadge
          status={node.status}
          branchHasError={node.branchHasError}
          hasError={node.hasError}
        />
      </div>
      {subtitle ? (
        <p className="trace-detail__headline-sub">{subtitle}</p>
      ) : null}
      {metrics.length > 0 ? (
        <p className="trace-detail__headline-metrics tabular-nums">{metrics.join(" · ")}</p>
      ) : null}
    </div>
  )
}

export type InspectorActionKind = "llm" | "tool" | "minimal"

export function inspectorActionKind(node: TraceTreeNode): InspectorActionKind {
  if (node.kind === "tool" || (node.kind === "work" && node.toolKey)) return "tool"
  if (node.kind === "call" || node.kind === "phase" || node.kind === "sent" || node.kind === "received") {
    return "llm"
  }
  return "minimal"
}
