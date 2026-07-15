import { beforeEach, describe, expect, it } from "vitest"
import { RunStatus } from "../src/enums"
import { useStore } from "../src/store"

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
})
