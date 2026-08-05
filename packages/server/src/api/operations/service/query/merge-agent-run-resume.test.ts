import { describe, expect, it } from "vitest"
import { OperationKind, OperationStatus } from "../../../../internal/enums/operations.js"
import {
  mergeAgentRunResumePipelines,
  type AgentRunResumeLookup,
} from "./merge-agent-run-resume.js"
import type { OperationPipeline } from "./types.js"

function pipe(
  partial: Partial<OperationPipeline> & Pick<OperationPipeline, "id" | "title" | "status">,
): OperationPipeline {
  return {
    kind: OperationKind.AgentRun,
    actorUpn: "u@x",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60_000,
    activityCount: 1,
    eventCount: 2,
    activities: [
      {
        id: `${partial.id}:a`,
        name: "step",
        status: partial.status,
        startedAt: partial.startedAt ?? "2026-01-01T00:00:00.000Z",
        endedAt: partial.endedAt ?? "2026-01-01T00:01:00.000Z",
        durationMs: 60_000,
        events: [],
      },
    ],
    ...partial,
  }
}

describe("mergeAgentRunResumePipelines", () => {
  it("collapses 3 approval resumes into one completed goal row", () => {
    const a = pipe({
      id: "a",
      title: "Weather in Prague",
      status: OperationStatus.Cancelled,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:30.000Z",
    })
    const b = pipe({
      id: "b",
      title: "Weather in Prague",
      status: OperationStatus.Cancelled,
      startedAt: "2026-01-01T00:00:30.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
    })
    const c = pipe({
      id: "c",
      title: "Weather in Prague",
      status: OperationStatus.Success,
      startedAt: "2026-01-01T00:01:00.000Z",
      endedAt: "2026-01-01T00:02:00.000Z",
    })

    const parents: Record<string, string | null> = {
      a: null,
      b: "a",
      c: "b",
    }
    const children = new Set(["a", "b"])

    const lookup: AgentRunResumeLookup = {
      parentRunId: (id) => parents[id] ?? null,
      hasResumeChild: (id) => children.has(id),
      rootMeta: (id) => {
        let cur: string | null = id
        let startedAt = "2026-01-01T00:00:00.000Z"
        let title = "Weather in Prague"
        const seen = new Set<string>()
        while (cur && !seen.has(cur)) {
          seen.add(cur)
          const parentId: string | null = parents[cur] ?? null
          if (!parentId) break
          cur = parentId
          startedAt = "2026-01-01T00:00:00.000Z"
          title = "Weather in Prague"
        }
        return { startedAt, title }
      },
    }

    const out = mergeAgentRunResumePipelines([a, b, c], lookup)
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe("c")
    expect(out[0]!.status).toBe(OperationStatus.Success)
    expect(out[0]!.title).toBe("Weather in Prague")
    expect(out[0]!.startedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(out[0]!.activityCount).toBe(3)
    expect(out[0]!.eventCount).toBe(6)
  })

  it("hides a cancelled parent when only the parent is on the page but a child exists in DB", () => {
    const parent = pipe({
      id: "p",
      title: "goal",
      status: OperationStatus.Cancelled,
    })
    const lookup: AgentRunResumeLookup = {
      parentRunId: () => null,
      hasResumeChild: (id) => id === "p",
      rootMeta: () => null,
    }
    expect(mergeAgentRunResumePipelines([parent], lookup)).toHaveLength(0)
  })

  it("remaps colliding lifecycle activity ids across resume segments", () => {
    const parent = pipe({
      id: "parent",
      title: "goal",
      status: OperationStatus.Cancelled,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:30.000Z",
      activities: [
        {
          id: "approval:2",
          name: "approval required",
          status: OperationStatus.Cancelled,
          startedAt: "2026-01-01T00:00:10.000Z",
          endedAt: "2026-01-01T00:00:10.000Z",
          durationMs: 0,
          events: [],
        },
        {
          id: "cancelled",
          name: "cancelled",
          status: OperationStatus.Cancelled,
          startedAt: "2026-01-01T00:00:20.000Z",
          endedAt: "2026-01-01T00:00:20.000Z",
          durationMs: 0,
          events: [],
        },
        {
          id: "telemetry:notification:3",
          name: "notification",
          status: OperationStatus.Success,
          startedAt: "2026-01-01T00:00:21.000Z",
          endedAt: "2026-01-01T00:00:21.000Z",
          durationMs: 0,
          events: [],
        },
      ],
    })
    const child = pipe({
      id: "child",
      title: "goal",
      status: OperationStatus.Success,
      startedAt: "2026-01-01T00:00:30.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      activities: [
        {
          id: "approval:2",
          name: "approval required",
          status: OperationStatus.Success,
          startedAt: "2026-01-01T00:00:40.000Z",
          endedAt: "2026-01-01T00:00:40.000Z",
          durationMs: 0,
          events: [],
        },
        {
          id: "telemetry:notification:3",
          name: "notification",
          status: OperationStatus.Success,
          startedAt: "2026-01-01T00:00:41.000Z",
          endedAt: "2026-01-01T00:00:41.000Z",
          durationMs: 0,
          events: [],
        },
      ],
    })

    const lookup: AgentRunResumeLookup = {
      parentRunId: (id) => (id === "child" ? "parent" : null),
      hasResumeChild: (id) => id === "parent",
      rootMeta: () => ({ startedAt: parent.startedAt, title: "goal" }),
    }

    const out = mergeAgentRunResumePipelines([parent, child], lookup)
    expect(out).toHaveLength(1)
    const ids = out[0]!.activities.map((activity) => activity.id)
    expect(ids).toEqual([
      "parent:approval:2",
      "parent:cancelled",
      "parent:telemetry:notification:3",
      "child:approval:2",
      "child:telemetry:notification:3",
    ])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("leaves non-agent pipelines untouched", () => {
    const sync = pipe({
      id: "s1",
      title: "sync",
      status: OperationStatus.Success,
      kind: OperationKind.SyncExecute,
    })
    const agent = pipe({
      id: "r1",
      title: "goal",
      status: OperationStatus.Success,
    })
    const lookup: AgentRunResumeLookup = {
      parentRunId: () => null,
      hasResumeChild: () => false,
      rootMeta: () => null,
    }
    const out = mergeAgentRunResumePipelines([sync, agent], lookup)
    expect(out.map((o) => o.id).sort()).toEqual(["r1", "s1"])
  })
})
