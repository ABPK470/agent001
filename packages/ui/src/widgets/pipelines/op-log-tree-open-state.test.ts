import { describe, expect, it } from "vitest"
import type { OperationPipeline } from "../../client/index"
import { OperationKind } from "../../client/index"
import {
  collectExpandableActivityKeys,
  collapsedTreeOpenState,
  expandedTreeOpenState,
  pruneTreeOpenState,
  treeOpenStateForFoldMode,
} from "./op-log-tree-open-state"

function activityKey(pipelineId: string, activityId: string, parentKey?: string): string {
  if (parentKey) return `${parentKey}/${activityId}`
  return `${pipelineId}|${activityId}`
}

const samplePipeline: OperationPipeline = {
  id: "p1",
  kind: OperationKind.SyncRun,
  title: "Sync",
  status: "success",
  startedAt: new Date().toISOString(),
  endedAt: null,
  durationMs: 300,
  activityCount: 2,
  eventCount: 0,
  activities: [
    {
      id: "phase:preview",
      name: "Preview",
      status: "success",
      durationMs: 100,
      events: [],
      children: [
        {
          id: "step:a",
          name: "Step A",
          status: "success",
          durationMs: 50,
          events: [],
          children: [],
        },
      ],
    },
    {
      id: "phase:execute",
      name: "Execute",
      status: "success",
      durationMs: 200,
      events: [],
      children: [],
    },
  ],
}

describe("op-log-tree-open-state", () => {
  it("expanded opens every pipeline and branch activity", () => {
    const state = expandedTreeOpenState([samplePipeline], activityKey)
    expect(state.foldMode).toBe("expanded")
    expect(state.openPipelineIds).toEqual(new Set(["p1"]))
    expect(state.actExpanded).toEqual(new Set(["p1|phase:preview"]))
    expect(state.collapsedDays.size).toBe(0)
  })

  it("collapsed clears tree open sets", () => {
    const state = collapsedTreeOpenState()
    expect(state.foldMode).toBe("collapsed")
    expect(state.openPipelineIds.size).toBe(0)
    expect(state.actExpanded.size).toBe(0)
  })

  it("treeOpenStateForFoldMode mirrors mode", () => {
    expect(
      treeOpenStateForFoldMode([samplePipeline], "expanded", activityKey).foldMode,
    ).toBe("expanded")
    expect(
      treeOpenStateForFoldMode([samplePipeline], "collapsed", activityKey).openPipelineIds.size,
    ).toBe(0)
  })

  it("collectExpandableActivityKeys skips leaves", () => {
    const keys = collectExpandableActivityKeys([samplePipeline], activityKey)
    expect(keys.has("p1|phase:preview")).toBe(true)
    expect(keys.has("p1|phase:execute")).toBe(false)
  })

  it("prune drops vanished ids and leaves state alone when pipelines empty", () => {
    const open = {
      foldMode: "collapsed" as const,
      openPipelineIds: new Set(["p1", "gone"]),
      actExpanded: new Set(["p1|phase:preview", "gone|x"]),
      collapsedDays: new Set(["Mon"]),
    }
    expect(pruneTreeOpenState(open, [], activityKey)).toBe(open)
    const pruned = pruneTreeOpenState(open, [samplePipeline], activityKey)
    expect(pruned.openPipelineIds).toEqual(new Set(["p1"]))
    expect(pruned.actExpanded).toEqual(new Set(["p1|phase:preview"]))
    expect(pruned.collapsedDays).toEqual(new Set(["Mon"]))
  })
})
