/**
 * Inspector header — title, status badge, metrics line (left column of hero banner).
 */

import { formatMs } from "../../lib/util"
import type { TraceTreeNode } from "./trace-tree-index"
import { TraceTreeStatusBadge } from "./TraceTreeStatusBadge"
import { tokenPairLabel } from "./trace-format"

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

function headlineSubtitle(node: TraceTreeNode): string | null {
  if (!node.subtitle) return null
  if (node.kind === "call") return null
  const normalized = node.subtitle.trim().toLowerCase()
  if (
    node.status === "success" &&
    (normalized === "done" || normalized === "success" || normalized.startsWith("success"))
  ) {
    return null
  }
  return node.subtitle
}

function headlineMetricsLine(node: TraceTreeNode): string | null {
  const parts: string[] = []
  if (node.durationMs != null) parts.push(formatMs(node.durationMs))
  if (node.promptTokens > 0 || node.completionTokens > 0) {
    parts.push(tokenPairLabel(node.promptTokens, node.completionTokens))
  } else if (node.kind === "call" || node.kind === "phase" || node.kind === "sent") {
    parts.push("0 tokens")
  }

  const subtitle = headlineSubtitle(node)
  if (subtitle && !parts.some((p) => p.includes(subtitle))) {
    parts.unshift(subtitle)
  }

  return parts.length > 0 ? parts.join(" · ") : null
}

export function TraceInspectorHeadline({ node }: { node: TraceTreeNode }) {
  const metricsLine = headlineMetricsLine(node)

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
      {metricsLine ? (
        <p className="trace-detail__headline-metrics tabular-nums">{metricsLine}</p>
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
