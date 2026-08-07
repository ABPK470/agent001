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
    case "call": {
      // Match left tree: "Call 1 ask_user" → "Call 1 — ask_user (gpt-demo)".
      const lead = node.leading?.trim() || "Call"
      const outcome = node.name.trim()
      const model = node.subtitle?.trim()
      const base = outcome ? `${lead} — ${outcome}` : lead
      return model ? `${base} (${model})` : base
    }
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
  // Badge already says OK / FAIL / Run — never echo status as a subtitle.
  if (
    normalized === "done" ||
    normalized === "success" ||
    normalized.startsWith("success") ||
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "running" ||
    normalized === "proposed" ||
    normalized === "skipped"
  ) {
    return null
  }
  return node.subtitle
}

/**
 * Metrics line under the title — duration + tokens/subtitle.
 * Keeps row-1 free for identity so actions can't starve the Call title.
 */
export function headlineRow2Line(node: TraceTreeNode): string | null {
  const parts: string[] = []
  if (node.durationMs != null && node.durationMs > 0) {
    parts.push(formatMs(node.durationMs))
  }
  const subtitle = headlineSubtitle(node)
  if (subtitle) {
    parts.push(subtitle)
  } else if (node.promptTokens > 0 || node.completionTokens > 0) {
    parts.push(tokenPairLabel(node.promptTokens, node.completionTokens))
  } else if (node.kind === "call" || node.kind === "phase" || node.kind === "sent") {
    parts.push("0 tokens")
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

export function TraceInspectorHeadlinePrimary({ node }: { node: TraceTreeNode }) {
  return (
    <div className="trace-detail__headline trace-detail__headline--split">
      <div className="trace-detail__headline-row">
        <span className="trace-detail__headline-lead">
          <span className="trace-detail__headline-title">{inspectorTitle(node)}</span>
          <TraceTreeStatusBadge
            status={node.status}
            branchHasError={node.branchHasError}
            hasError={node.hasError}
          />
        </span>
      </div>
    </div>
  )
}

export function TraceInspectorHeadlineSecondary({ node }: { node: TraceTreeNode }) {
  const row2 = headlineRow2Line(node)
  if (!row2) {
    return (
      <span className="trace-detail__headline-row2 trace-detail__headline-row2--empty" aria-hidden />
    )
  }
  return <p className="trace-detail__headline-row2 tabular-nums">{row2}</p>
}

export function TraceInspectorHeadline({ node }: { node: TraceTreeNode }) {
  const row2 = headlineRow2Line(node)

  return (
    <div className="trace-detail__headline">
      <div className="trace-detail__headline-row">
        <span className="trace-detail__headline-lead">
          <span className="trace-detail__headline-title">{inspectorTitle(node)}</span>
          <TraceTreeStatusBadge
            status={node.status}
            branchHasError={node.branchHasError}
            hasError={node.hasError}
          />
        </span>
      </div>
      {row2 ? <p className="trace-detail__headline-metrics tabular-nums">{row2}</p> : null}
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
