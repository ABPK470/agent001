import { describe, expect, it } from "vitest"
import { RunStatus } from "../../enums"
import { terminalSpanStatus } from "./run-terminal"

describe("terminalSpanStatus", () => {
  it("returns null while the run is live or waiting", () => {
    expect(terminalSpanStatus(RunStatus.Running)).toBeNull()
    expect(terminalSpanStatus(RunStatus.Planning)).toBeNull()
    expect(terminalSpanStatus(RunStatus.WaitingForApproval)).toBeNull()
    expect(terminalSpanStatus(null)).toBeNull()
  })

  it("seals completed/cancelled as done and failures as error", () => {
    expect(terminalSpanStatus(RunStatus.Completed)).toBe("done")
    expect(terminalSpanStatus(RunStatus.Cancelled)).toBe("done")
    expect(terminalSpanStatus(RunStatus.Failed)).toBe("error")
    expect(terminalSpanStatus(RunStatus.Crashed)).toBe("error")
  })
})
