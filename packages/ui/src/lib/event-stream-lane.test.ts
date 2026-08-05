import { describe, expect, it } from "vitest"
import {
  EVENT_STREAM_LANES,
  eventStreamLane,
  eventStreamLaneDbPatterns,
  eventStreamLanesDbPatterns,
} from "./event-stream-lane"

describe("eventStreamLane — BE-aligned scan buckets", () => {
  it("keeps the seven stable filter labels", () => {
    expect([...EVENT_STREAM_LANES]).toEqual([
      "run",
      "step",
      "sync",
      "bridge",
      "agent",
      "api",
      "system",
    ])
  })

  it("maps job envelope to run (including legacy agent lifecycle)", () => {
    expect(eventStreamLane("run.started")).toBe("run")
    expect(eventStreamLane("run.failed")).toBe("run")
    expect(eventStreamLane("agent.started")).toBe("run")
    expect(eventStreamLane("agent.completed")).toBe("run")
    expect(eventStreamLane("agent.failed")).toBe("run")
    expect(eventStreamLane("agent.cancelled")).toBe("run")
    expect(eventStreamLane("agent.user_safe_failure")).toBe("run")
  })

  it("maps atomic tool work to step — not agent or system", () => {
    expect(eventStreamLane("step.started")).toBe("step")
    expect(eventStreamLane("step.completed")).toBe("step")
    expect(eventStreamLane("tool_call.executing")).toBe("step")
    expect(eventStreamLane("tool.invoked")).toBe("step")
    expect(eventStreamLane("tool.blocked")).toBe("step")
    expect(eventStreamLane("tool.failed")).toBe("step")
  })

  it("maps cognition / orchestration to agent — distinct from step", () => {
    expect(eventStreamLane("planner.started")).toBe("agent")
    expect(eventStreamLane("planner.step.started")).toBe("agent")
    expect(eventStreamLane("delegation.started")).toBe("agent")
    expect(eventStreamLane("agent.thinking")).toBe("agent")
    expect(eventStreamLane("agent.bus.message")).toBe("agent")
    expect(eventStreamLane("debug.trace")).toBe("agent")
    // Plan-named step events are orchestration wire, not tool step.* 
    expect(eventStreamLane("planner.step.completed")).not.toBe("step")
  })

  it("puts sync_env with sync data plane (not system)", () => {
    expect(eventStreamLane("sync.preview.started")).toBe("sync")
    expect(eventStreamLane("sync_env.changed")).toBe("sync")
  })

  it("keeps bridge / api / residual system separate", () => {
    expect(eventStreamLane("bridge.run.started")).toBe("bridge")
    expect(eventStreamLane("api.request")).toBe("api")
    expect(eventStreamLane("session.presence.tick")).toBe("system")
    expect(eventStreamLane("events.connected")).toBe("system")
    expect(eventStreamLane("approval.required")).toBe("system")
    expect(eventStreamLane("memory.updated")).toBe("system")
  })
})

describe("eventStreamLaneDbPatterns — search stays aligned with classifier", () => {
  it("step search includes tool.* (not only step. / tool_call.)", () => {
    expect(eventStreamLaneDbPatterns("step")).toEqual(
      expect.arrayContaining(["step.", "tool_call.", "tool."]),
    )
  })

  it("sync search includes sync_env; system does not", () => {
    expect(eventStreamLaneDbPatterns("sync")).toContain("sync_env.")
    expect(eventStreamLaneDbPatterns("system")).not.toContain("sync_env.")
  })

  it("agent search does not use bare agent. (would steal run lifecycle)", () => {
    const agent = eventStreamLaneDbPatterns("agent")
    expect(agent).not.toContain("agent.")
    expect(agent).toEqual(
      expect.arrayContaining(["planner.", "delegation.", "agent.thinking"]),
    )
    const run = eventStreamLaneDbPatterns("run")
    expect(run).toContain("agent.started")
    expect(run).toContain("run.")
  })

  it("flattens multi-lane filters", () => {
    expect(eventStreamLanesDbPatterns(new Set(["step", "sync"]))).toEqual(
      expect.arrayContaining(["step.", "tool.", "sync.", "sync_env."]),
    )
    expect(eventStreamLanesDbPatterns([])).toBeUndefined()
  })
})
