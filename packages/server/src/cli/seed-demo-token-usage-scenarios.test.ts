import { describe, expect, it } from "vitest"
import {
  DEMO_USAGE_RUN_PREFIX,
  DEMO_USAGE_SCENARIOS,
  DEMO_USAGE_USERS,
  demoUsageRunId,
  demoUsageThreadId,
} from "./seed-demo-token-usage-scenarios.js"

describe("demo token usage scenarios", () => {
  it("covers multiple users, models, sizes, and outcomes for sort/filter", () => {
    const upns = new Set(DEMO_USAGE_SCENARIOS.map((s) => s.upn))
    const models = new Set(DEMO_USAGE_SCENARIOS.map((s) => s.model))
    const statuses = new Set(DEMO_USAGE_SCENARIOS.map((s) => s.status))
    const totals = DEMO_USAGE_SCENARIOS.map((s) => s.promptTokens + s.completionTokens)
    const hours = DEMO_USAGE_SCENARIOS.map((s) => s.hoursAgo)

    expect(DEMO_USAGE_SCENARIOS.length).toBeGreaterThanOrEqual(10)
    expect(upns.size).toBeGreaterThanOrEqual(3)
    expect(models.size).toBeGreaterThanOrEqual(3)
    expect(statuses.has("completed")).toBe(true)
    expect(statuses.has("failed")).toBe(true)
    expect(Math.min(...totals)).toBeLessThan(2_000)
    expect(Math.max(...totals)).toBeGreaterThan(50_000)
    expect(Math.min(...hours)).toBeLessThan(5)
    expect(Math.max(...hours)).toBeGreaterThan(100)
    expect(DEMO_USAGE_USERS.map((u) => u.upn).sort()).toEqual([...upns].sort())
  })

  it("uses stable demo-usage ids", () => {
    const ids = DEMO_USAGE_SCENARIOS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(demoUsageRunId("heavy-gpt54")).toBe(`${DEMO_USAGE_RUN_PREFIX}heavy-gpt54`)
    expect(demoUsageThreadId("alice")).toBe(`${DEMO_USAGE_RUN_PREFIX}thread-alice`)
  })
})
