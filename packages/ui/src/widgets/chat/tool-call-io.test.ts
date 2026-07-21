import { describe, expect, it } from "vitest"
import {
  buildToolIoFromStepEvents,
  formatToolIoMeta,
  isAgentStepEventType,
  readToolIoFromEvent,
  stripToolIoForInlineDisplay,
} from "./tool-call-io"

describe("tool-call-io", () => {
  it("reads tool I/O from a step.started event", () => {
    const io = readToolIoFromEvent({
      type: "step.started",
      timestamp: "2026-07-12T10:00:00.000Z",
      data: {
        action: "run_command",
        input: { command: "ls -la" },
      },
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
        data: { action: "sync_preview", input: { planId: "p1" } },
      },
      {
        type: "step.completed",
        timestamp: "2026-07-12T10:00:05.000Z",
        data: {
          action: "sync_preview",
          durationMs: 5000,
          output: { result: "Preview ready" },
        },
      },
    ])
    expect(io?.status).toBe("success")
    expect(io?.outputText).toBe("Preview ready")
    expect(io?.durationMs).toBe(5000)
  })

  it("marks failed steps and formats meta", () => {
    expect(isAgentStepEventType("step.failed")).toBe(true)
    expect(isAgentStepEventType("run.completed")).toBe(false)

    const io = buildToolIoFromStepEvents([
      {
        type: "step.started",
        timestamp: "2026-07-12T10:00:00.000Z",
        data: { action: "run_command", input: { command: "false" } },
      },
      {
        type: "step.failed",
        timestamp: "2026-07-12T10:00:01.000Z",
        data: { action: "run_command", error: "exit 1", durationMs: 12 },
      },
    ])
    expect(io?.status).toBe("failed")
    expect(io?.error).toBe("exit 1")
    expect(formatToolIoMeta(io!)).toMatch(/failed|12|run_command/i)
  })

  it("strips heavy fields for inline display", () => {
    const stripped = stripToolIoForInlineDisplay({
      tool: "query_mssql",
      status: "success",
      input: { sql: "select 1" },
      inputFormatted: "sql=...",
      output: { result: "1" },
      outputText: "1",
    })
    expect(stripped.input).toBeUndefined()
    expect(stripped.output).toBeUndefined()
    expect(stripped.tool).toBe("query_mssql")
  })
})
