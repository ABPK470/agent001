import { describe, expect, it } from "vitest"
import { RunStatus } from "../../enums"
import {
  deriveTranscriptZones,
  isLiveTranscriptTurn,
  isRunActiveStatus,
} from "./transcriptZones"

describe("transcriptZones", () => {
  it("treats pending/running/planning as active", () => {
    expect(isRunActiveStatus(RunStatus.Running)).toBe(true)
    expect(isRunActiveStatus(RunStatus.Completed)).toBe(false)
  })

  it("keeps a streaming completed answer in the live zone until cleared", () => {
    expect(
      isLiveTranscriptTurn({ status: RunStatus.Completed, streamingAnswer: "hi" }),
    ).toBe(true)
    expect(
      isLiveTranscriptTurn({ status: RunStatus.Completed, streamingAnswer: "" }),
    ).toBe(false)
  })

  it("pulls the scoped live run out of settled VirtualList items", () => {
    const runs = [
      { id: "a", status: RunStatus.Completed },
      { id: "b", status: RunStatus.Running, streamingAnswer: "" },
    ]
    const { settledRuns, liveRun } = deriveTranscriptZones(runs, runs[1], "b")
    expect(settledRuns.map((r) => r.id)).toEqual(["a"])
    expect(liveRun?.id).toBe("b")
  })

  it("leaves all turns settled when nothing is live", () => {
    const runs = [
      { id: "a", status: RunStatus.Completed },
      { id: "b", status: RunStatus.Completed },
    ]
    const { settledRuns, liveRun } = deriveTranscriptZones(runs, runs[1], "b")
    expect(liveRun).toBeNull()
    expect(settledRuns.map((r) => r.id)).toEqual(["a", "b"])
  })

  it("single live thread → empty settled list", () => {
    const runs = [{ id: "only", status: RunStatus.Pending }]
    const { settledRuns, liveRun } = deriveTranscriptZones(runs, runs[0], "only")
    expect(settledRuns).toEqual([])
    expect(liveRun?.id).toBe("only")
  })
})
