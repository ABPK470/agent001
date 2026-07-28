import { describe, expect, it } from "vitest"
import { RunQueue } from "../src/infra/queue/run-queue.js"
import { MemoryConnectionBudget, agentBudgetLimit, syncBudgetLimit } from "../src/ports/connection-budget.js"
import {
  enrichEventDataWithOwner,
  MemoryRunOwnerIndex,
  ownerFromEventDataHot,
} from "../src/ports/run-owner-index.js"
import { LlmThrottle } from "../src/ports/llm-throttle.js"
import type { LLMClient, LLMResponse, Message, Tool } from "@mia/agent"

describe("RunQueue per-UPN fairness", () => {
  it("caps concurrent runs per UPN while allowing other users", async () => {
    const q = new RunQueue(4, 1)
    const releases: Array<() => void> = []
    const a1 = q.acquire("r1", undefined, undefined, "a@x")
    const a2 = q.acquire("r2", undefined, undefined, "a@x")
    const b1 = q.acquire("r3", undefined, undefined, "b@x")

    const releaseA1 = await a1
    releases.push(releaseA1)
    const releaseB1 = await b1
    releases.push(releaseB1)

    let a2Started = false
    void a2.then((rel) => {
      a2Started = true
      releases.push(rel)
    })
    await Promise.resolve()
    expect(a2Started).toBe(false)
    expect(q.stats().byUpn["a@x"]?.active).toBe(1)
    expect(q.stats().byUpn["b@x"]?.active).toBe(1)

    releaseA1()
    await Promise.resolve()
    expect(a2Started).toBe(true)
    for (const rel of releases) rel()
  })
})

describe("RunOwnerIndex hot path", () => {
  it("stamps actorUpn from run index without inventing owners", () => {
    const index = new MemoryRunOwnerIndex()
    index.rememberRun("run-1", "User@X.com")
    expect(ownerFromEventDataHot({ runId: "run-1" }, index)).toBe("user@x.com")
    const enriched = enrichEventDataWithOwner({ runId: "run-1", foo: 1 }, index)
    expect(enriched["actorUpn"]).toBe("user@x.com")
    expect(ownerFromEventDataHot({ type: "noise" }, index)).toBeNull()
  })
})

describe("ConnectionBudget", () => {
  it("separates agent-query and sync-work leases", async () => {
    const budget = new MemoryConnectionBudget()
    const order: string[] = []
    const agent = budget.withSlot("c1", "agent-query", 1, async () => {
      order.push("agent-enter")
      await Promise.resolve()
      order.push("agent-exit")
      return "a"
    })
    const sync = budget.withSlot("c1", "sync-work", 1, async () => {
      order.push("sync-enter")
      await Promise.resolve()
      order.push("sync-exit")
      return "s"
    })
    await Promise.all([agent, sync])
    expect(order).toEqual(["agent-enter", "sync-enter", "agent-exit", "sync-exit"])
    expect(agentBudgetLimit(10)).toBeGreaterThanOrEqual(1)
    expect(syncBudgetLimit(10)).toBeGreaterThanOrEqual(1)
    expect(agentBudgetLimit(10) + syncBudgetLimit(10)).toBeLessThanOrEqual(10)
  })
})

describe("LlmThrottle", () => {
  it("serializes chat calls when limit is 1", async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const inner: LLMClient = {
      async chat(_m: Message[], _t: Tool[]): Promise<LLMResponse> {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 10))
        concurrent--
        return { content: "ok", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }
      },
    }
    const client = new LlmThrottle(1).wrap(inner)
    await Promise.all([client.chat([], []), client.chat([], [])])
    expect(maxConcurrent).toBe(1)
  })
})
