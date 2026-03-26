import { beforeEach, describe, expect, it } from "vitest"
import { ActionNotFoundError } from "../../src/domain/errors.js"
import { ActionRegistry, StepExecutor } from "../../src/engine/executor.js"
import { FailingAction, FakeAction } from "../helpers.js"

describe("ActionRegistry", () => {
  let registry: ActionRegistry

  beforeEach(() => {
    registry = new ActionRegistry()
  })

  it("registers and retrieves a handler", () => {
    const handler = new FakeAction("test")
    registry.register(handler)
    expect(registry.get("test")).toBe(handler)
  })

  it("throws on unknown handler", () => {
    expect(() => registry.get("missing")).toThrow(ActionNotFoundError)
  })

  it("lists registered names", () => {
    registry.register(new FakeAction("a"))
    registry.register(new FakeAction("b"))
    expect(registry.listNames()).toEqual(["a", "b"])
  })

  it("unregisters a handler", () => {
    registry.register(new FakeAction("a"))
    registry.unregister("a")
    expect(() => registry.get("a")).toThrow(ActionNotFoundError)
  })
})

describe("StepExecutor", () => {
  it("executes action and returns result", async () => {
    const registry = new ActionRegistry()
    registry.register(new FakeAction("test", { answer: 42 }))
    const executor = new StepExecutor(registry)

    const result = await executor.execute(
      "test",
      { q: "?" },
      { runId: "r1", stepId: "s1" },
    )
    expect(result).toEqual({ answer: 42 })
  })

  it("executeAndRecord returns success record", async () => {
    const registry = new ActionRegistry()
    registry.register(new FakeAction("test", { ok: true }))
    const executor = new StepExecutor(registry)

    const record = await executor.executeAndRecord(
      "test",
      {},
      { runId: "r1", stepId: "s1" },
    )
    expect(record.success).toBe(true)
    expect(record.result).toEqual({ ok: true })
    expect(record.error).toBeNull()
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("executeAndRecord returns failure record on error", async () => {
    const registry = new ActionRegistry()
    registry.register(new FailingAction("test"))
    const executor = new StepExecutor(registry)

    const record = await executor.executeAndRecord(
      "test",
      {},
      { runId: "r1", stepId: "s1" },
    )
    expect(record.success).toBe(false)
    expect(record.error).toBe("boom")
  })
})
