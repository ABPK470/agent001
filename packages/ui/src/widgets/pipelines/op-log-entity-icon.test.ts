import { describe, expect, it } from "vitest"
import { Eye, Layers, ListChecks, Ship, Table2 } from "lucide-react"
import type { OperationActivity } from "../../client/index"
import { OperationKind, OperationStatus } from "../../client/index"
import {
  activityPhaseIcon,
  pipelineEntityIcon,
  resolveActivityTreeVisual,
} from "./op-log-entity-icon"

function activity(
  partial: Partial<OperationActivity> & Pick<OperationActivity, "id" | "name">,
): OperationActivity {
  return {
    status: OperationStatus.Success,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1,
    events: [],
    ...partial,
  }
}

describe("pipelineEntityIcon — root kind only", () => {
  it("maps sync / bridge / agent to distinct kind colors", () => {
    expect(pipelineEntityIcon(OperationKind.SyncRun).color).toBe("var(--color-info)")
    expect(pipelineEntityIcon(OperationKind.BridgePreview).color).toBe("var(--color-accent)")
    expect(pipelineEntityIcon(OperationKind.AgentRun).color).toBe("var(--color-accent)")
    expect(pipelineEntityIcon(OperationKind.SyncRun).Icon).not.toBe(
      pipelineEntityIcon(OperationKind.BridgePreview).Icon,
    )
  })
})

describe("activityPhaseIcon — functional stages, never kind fallback", () => {
  it("maps Preview / Execute / Preflight / MetadataSync", () => {
    expect(activityPhaseIcon(activity({ id: "phase:preview", name: "Preview" })).Icon).toBe(Eye)
    expect(activityPhaseIcon(activity({ id: "phase:execute", name: "Execute" })).Icon).toBe(Ship)
    expect(activityPhaseIcon(activity({ id: "preflight", name: "Preflight checks" })).Icon).toBe(
      ListChecks,
    )
    expect(activityPhaseIcon(activity({ id: "step", name: "MetadataSync" })).Icon).toBe(Table2)
  })

  it("uses neutral Layers for unknown expandable stages (not Database/Shuffle kind)", () => {
    const visual = activityPhaseIcon(activity({ id: "other", name: "Configured" }))
    expect(visual.Icon).toBe(Layers)
    expect(visual.color).toBe("var(--color-text-muted)")
  })
})

describe("resolveActivityTreeVisual — Kind Inheritance", () => {
  it("gives top-level phases (depth 1) a functional icon + status", () => {
    const visual = resolveActivityTreeVisual({
      activity: activity({
        id: "phase:preview",
        name: "Preview",
        children: [activity({ id: "c", name: "child" })],
      }),
      hasChildren: true,
      status: OperationStatus.Failed,
      depth: 1,
    })
    expect(visual).toEqual({
      type: "icon",
      Icon: Eye,
      color: "var(--color-info)",
      status: OperationStatus.Failed,
    })
  })

  it("gives nested expandables (MetadataSync) a functional icon + status like Preview", () => {
    const visual = resolveActivityTreeVisual({
      activity: activity({
        id: "metasync",
        name: "MetadataSync",
        children: [activity({ id: "c", name: "child" })],
      }),
      hasChildren: true,
      status: OperationStatus.Success,
      depth: 2,
    })
    expect(visual).toEqual({
      type: "icon",
      Icon: Table2,
      color: "var(--color-success)",
      status: OperationStatus.Success,
    })
  })

  it("gives leaves a status dot — never a kind/entity icon", () => {
    const visual = resolveActivityTreeVisual({
      activity: activity({ id: "started", name: "Started" }),
      hasChildren: false,
      status: OperationStatus.Success,
      depth: 2,
    })
    expect(visual).toEqual({ type: "status-dot", status: OperationStatus.Success })
  })

  it("Configured leaf under bridge is a status dot (no Shuffle inflation)", () => {
    const visual = resolveActivityTreeVisual({
      activity: activity({ id: "configured", name: "Configured" }),
      hasChildren: false,
      status: OperationStatus.Success,
      depth: 1,
    })
    expect(visual.type).toBe("status-dot")
  })
})
