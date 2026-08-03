import {
  Brain,
  Database,
  GitCompareArrows,
  Settings,
  Shuffle,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react"
import type { OperationActivity } from "../../client/index"
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

export function pipelineEntityIcon(kind: OperationKind): OpLogEntityVisual {
  return OP_LOG_KIND_META[kind] ?? OP_LOG_KIND_META.system
}

export function activityEntityIcon(
  pipelineKind: OperationKind,
  effectiveKind: OperationKind,
  activity: OperationActivity,
): OpLogEntityVisual {
  const name = activity.name.toLowerCase()
  const id = activity.id.toLowerCase()

  if (id === "phase:execute" || name === "execute") {
    return { Icon: Zap, color: "var(--color-warning)" }
  }
  if (id === "phase:preview" || name === "preview") {
    return { Icon: Database, color: "var(--color-info)" }
  }
  if (name.includes("metadatasync") || name === "metadatasync") {
    return { Icon: Database, color: "var(--color-success)" }
  }
  if (effectiveKind === OperationKind.AgentRun && activity.events.some((e) => e.type.startsWith("tool_call."))) {
    return { Icon: Wrench, color: "var(--color-accent)" }
  }
  if (effectiveKind === OperationKind.AgentRun) {
    return { Icon: Brain, color: "var(--color-accent)" }
  }
  return pipelineEntityIcon(effectiveKind !== pipelineKind ? effectiveKind : pipelineKind)
}
