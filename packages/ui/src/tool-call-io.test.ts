import { describe, expect, it } from "vitest"
import { buildToolIoFromStepEvents, readToolIoFromEvent } from "./tool-call-io"

describe("tool-call-io", () => {
  it("reads tool I/O from a step.started event", () => {
    const io = readToolIoFromEvent({
      type: "step.started",
      timestamp: "2026-07-12T10:00:00.000Z",
      data: {
        action: "run_command",
        input: { command: "ls -la" }
      }
    })
    expect(io?.tool).toBe("run_command")
    expect(io?.status).toBe("running")
    expect(io?.inputFormatted).toContain("ls -la")
  })

  it("merges started + completed events", () => {
    const io = buildToolIoFromStepEvents([
      {
        type: "step.started",
        timestamp: "2026-07-12T10:00:00.000Z",
        data: { action: "sync_preview", input: { planId: "p1" } }
      },
      {
        type: "step.completed",
        timestamp: "2026-07-12T10:00:05.000Z",
        data: {
          action: "sync_preview",
          durationMs: 5000,
          output: { result: "Preview ready" }
        }
      }
    ])
    expect(io?.status).toBe("success")
    expect(io?.outputText).toBe("Preview ready")
    expect(io?.durationMs).toBe(5000)
  })
})
