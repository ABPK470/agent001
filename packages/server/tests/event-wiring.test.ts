import { EventType } from "@mia/agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { broadcast, saveLog } = vi.hoisted(() => ({
  broadcast: vi.fn(),
  saveLog: vi.fn()
}))

vi.mock("../src/platform/events/broadcaster.js", () => ({
  broadcast,
  toBroadcastData: <T extends object>(value: T) => value as unknown as Record<string, unknown>
}))

vi.mock("../src/platform/persistence/sqlite.js", () => ({
  saveLog
}))

import { wireEventBroadcasting } from "../src/features/runs/core/coordination/event-wiring.js"

type DomainEventLike = {
  type: string
  runId?: string
  stepId?: string
  toolName?: string
  reason?: string
  eventId: string
  occurredAt: Date
}

class StubEventBus {
  private handlers = new Map<string, Set<(event: DomainEventLike) => Promise<void>>>()

  subscribe(eventType: string, handler: (event: DomainEventLike) => Promise<void>): () => void {
    const current = this.handlers.get(eventType) ?? new Set<(event: DomainEventLike) => Promise<void>>()
    current.add(handler)
    this.handlers.set(eventType, current)
    return () => {
      const listeners = this.handlers.get(eventType)
      if (!listeners) return
      listeners.delete(handler)
      if (listeners.size === 0) this.handlers.delete(eventType)
    }
  }

  async publish(event: DomainEventLike): Promise<void> {
    const listeners = this.handlers.get(event.type)
    if (!listeners) return
    for (const handler of listeners) await handler(event)
  }
}

function evt(type: string, extras: Partial<DomainEventLike> = {}): DomainEventLike {
  return {
    type,
    eventId: `event-${Math.random().toString(16).slice(2)}`,
    occurredAt: new Date(),
    ...extras
  }
}

describe("wireEventBroadcasting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("records only step events for the owning run", async () => {
    const eventBus = new StubEventBus()
    const auditLog = { subscribe: vi.fn(() => () => {}) }
    const saveTrace = vi.fn()
    const createNotification = vi.fn()
    const state = {
      run: {
        steps: [
          {
            id: "step-own",
            name: "ask_user (#0)",
            action: "ask_user",
            input: { question: "Most by what?" },
            output: {},
            error: null
          }
        ]
      }
    }

    const unsubscribe = wireEventBroadcasting(
      { eventBus, auditLog },
      "run-own",
      state,
      saveTrace,
      createNotification
    )

    await eventBus.publish(evt(EventType.StepStarted, { runId: "run-other", stepId: "step-other" }))
    await eventBus.publish(evt(EventType.StepStarted, { runId: "run-own", stepId: "step-own" }))

    expect(saveTrace).toHaveBeenCalledTimes(1)
    expect(saveTrace).toHaveBeenCalledWith(
      "run-own",
      expect.objectContaining({ kind: "tool-call", tool: "ask_user", invocationId: "step-own" })
    )
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EventType.StepStarted,
        data: expect.objectContaining({ stepId: "step-own", action: "ask_user" }),
      }),
    )
    expect(saveLog).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it("ignores approval events from other runs", async () => {
    const eventBus = new StubEventBus()
    const auditLog = { subscribe: vi.fn(() => () => {}) }
    const saveTrace = vi.fn()
    const createNotification = vi.fn()
    const state = { run: { steps: [] } }

    const unsubscribe = wireEventBroadcasting(
      { eventBus, auditLog },
      "run-own",
      state,
      saveTrace,
      createNotification
    )

    await eventBus.publish(
      evt("approval.required", {
        runId: "run-other",
        stepId: "step-other",
        toolName: "ask_user",
        reason: "approval needed"
      })
    )

    expect(createNotification).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()

    unsubscribe()
  })
})
