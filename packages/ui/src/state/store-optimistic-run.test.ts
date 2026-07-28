import { beforeEach, describe, expect, it } from "vitest"
import { RunStatus } from "../enums"
import { useStore } from "./store"

describe("beginOptimisticRun", () => {
  beforeEach(() => {
    useStore.setState({
      runs: [],
      activeRunId: null,
      activeThreadId: "thread-1",
    })
  })

  it("creates a pending run row and selects it before SSE arrives", () => {
    useStore.getState().beginOptimisticRun({
      id: "run-live",
      goal: "Top 5 bankers",
      threadId: "thread-1",
    })

    const state = useStore.getState()
    expect(state.activeRunId).toBe("run-live")
    const run = state.runs.find((r) => r.id === "run-live")
    expect(run?.goal).toBe("Top 5 bankers")
    expect(run?.status).toBe(RunStatus.Pending)
    expect(run?.trace?.[0]).toEqual({ kind: "goal", text: "Top 5 bankers" })
  })

  it("remount auto-select guard: live active run is not overwritten", () => {
    useStore.getState().beginOptimisticRun({
      id: "run-live",
      goal: "Still running",
      threadId: "thread-1",
    })
    useStore.getState().upsertRun({
      id: "run-old",
      goal: "Previous",
      threadId: "thread-1",
      status: RunStatus.Completed,
      createdAt: new Date(0).toISOString(),
    })

    const active = useStore.getState().runs.find((r) => r.id === useStore.getState().activeRunId)
    expect(active?.id).toBe("run-live")
    expect(active?.status).toBe(RunStatus.Pending)
  })

  it("appends a second goal on the same thread and selects it (chat transcript source)", () => {
    useStore.getState().beginOptimisticRun({
      id: "run-1",
      goal: "First",
      threadId: "thread-1",
    })
    useStore.getState().upsertRun({
      id: "run-1",
      status: RunStatus.Completed,
      completedAt: new Date().toISOString(),
    })

    useStore.getState().beginOptimisticRun({
      id: "run-2",
      goal: "Second goal",
      threadId: "thread-1",
    })

    const state = useStore.getState()
    expect(state.activeRunId).toBe("run-2")
    const threadRuns = state.runs.filter((r) => r.threadId === "thread-1")
    expect(threadRuns.map((r) => r.id)).toEqual(expect.arrayContaining(["run-1", "run-2"]))
    expect(threadRuns.find((r) => r.id === "run-2")?.goal).toBe("Second goal")
  })
})
