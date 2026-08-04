/**
 * Pipelines tree icon hierarchy (Kind Inheritance):
 *   Root run     → kind icon (Sync / Bridge / Agent)
 *   Expandable   → functional step icon + corner status badge (Preview / Execute / MetadataSync)
 *   Leaf         → status dot only (no icon inflation)
 */

import {
  Brain,
  Database,
  Eye,
  GitCompareArrows,
  Layers,
  ListChecks,
  Settings,
  Ship,
  Shuffle,
  Table2,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import type { OperationActivity, OperationStatus } from "../../client/index"
import { OperationKind } from "../../client/index"

export const OP_LOG_KIND_META: Record<
  OperationKind,
  { label: string; Icon: LucideIcon; color: string }
> = {
  "agent-run": { label: "agent", Icon: Brain, color: "var(--color-accent)" },
  "sync-preview": { label: "preview", Icon: Database, color: "var(--color-info)" },
  "sync-execute": { label: "execute", Icon: Database, color: "var(--color-success)" },
  "sync-run": { label: "sync", Icon: Database, color: "var(--color-info)" },
  "proposer-run": { label: "scan", Icon: GitCompareArrows, color: "var(--color-warning)" },
  "bridge-preview": { label: "bridge", Icon: Shuffle, color: "var(--color-accent)" },
  "bridge-run": { label: "bridge", Icon: Shuffle, color: "var(--color-accent)" },
  system: { label: "system", Icon: Settings, color: "var(--color-text-muted)" },
}

export type OpLogEntityVisual = { Icon: LucideIcon; color: string }

export type OpLogActivityTreeVisual =
  | { type: "icon"; Icon: LucideIcon; color: string; status: OperationStatus }
  | { type: "status-dot"; status: OperationStatus }

export function pipelineEntityIcon(kind: OperationKind): OpLogEntityVisual {
  return OP_LOG_KIND_META[kind] ?? OP_LOG_KIND_META.system
}

/** Functional icon for an expandable stage — never the pipeline kind icon. */
export function activityPhaseIcon(activity: OperationActivity): OpLogEntityVisual {
  const name = activity.name.toLowerCase()
  const id = activity.id.toLowerCase()

  if (id === "phase:preview" || name === "preview") {
    return { Icon: Eye, color: "var(--color-info)" }
  }
  if (id === "phase:execute" || name === "execute") {
    return { Icon: Ship, color: "var(--color-success)" }
  }
  if (name.includes("preflight")) {
    return { Icon: ListChecks, color: "var(--color-info)" }
  }
  if (name.includes("metadatasync") || name === "metadatasync") {
    return { Icon: Table2, color: "var(--color-success)" }
  }
  if (activity.events.some((e) => e.type.startsWith("tool_call."))) {
    return { Icon: Wrench, color: "var(--color-accent)" }
  }
  return { Icon: Layers, color: "var(--color-text-muted)" }
}

/**
 * Left-tree activity visual.
 * Any expandable (Preview / Execute / MetadataSync) gets chevron + functional icon
 * + corner status badge. Leaves keep the status-dot glyph so the icon column stays
 * one vertical axis (chevron slot is reserved on every row).
 */
export function resolveActivityTreeVisual(opts: {
  activity: OperationActivity
  hasChildren: boolean
  status: OperationStatus
  /** Flat-row depth (kept for callers / tests; policy is hasChildren). */
  depth: number
}): OpLogActivityTreeVisual {
  if (opts.hasChildren) {
    const phase = activityPhaseIcon(opts.activity)
    return { type: "icon", Icon: phase.Icon, color: phase.color, status: opts.status }
  }
  return { type: "status-dot", status: opts.status }
}
