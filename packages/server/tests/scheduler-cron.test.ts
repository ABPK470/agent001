/**
 * F1.5 — scheduler cron parsing tests (pure, no DB).
 */

import { describe, expect, it } from "vitest"
import { nextCronMatch } from "../src/features/proposer/scheduler.js"

describe("nextCronMatch", () => {
  it("hourly fires at next :00", () => {
    const at = new Date("2025-01-15T10:23:00.000Z")
    const next = nextCronMatch("0 * * * *", at)
    expect(next?.toISOString()).toBe("2025-01-15T11:00:00.000Z")
  })

  it("every 6 hours fires at next 0/6/12/18", () => {
    const at = new Date("2025-01-15T13:23:00.000Z")
    const next = nextCronMatch("0 */6 * * *", at)
    expect(next?.toISOString()).toBe("2025-01-15T18:00:00.000Z")
  })

  it("specific minute list (0,30) fires at next 30 within same hour", () => {
    const at = new Date("2025-01-15T10:05:00.000Z")
    const next = nextCronMatch("0,30 * * * *", at)
    expect(next?.toISOString()).toBe("2025-01-15T10:30:00.000Z")
  })

  it("rejects invalid cron", () => {
    expect(nextCronMatch("xx yy", new Date())).toBeNull()
    expect(nextCronMatch("99 * * * *", new Date())).toBeNull()
  })

  it("respects month range (1-3) and rolls into next year", () => {
    const at = new Date("2025-04-01T00:00:00.000Z")
    const next = nextCronMatch("0 0 1 1-3 *", at)
    expect(next?.toISOString()).toBe("2026-01-01T00:00:00.000Z")
  })

  it("day-of-week filter (Mon=1) selects Mondays only", () => {
    // 2025-01-15 is a Wednesday; next Monday 09:00 UTC is 2025-01-20
    const at = new Date("2025-01-15T10:00:00.000Z")
    const next = nextCronMatch("0 9 * * 1", at)
    expect(next?.toISOString()).toBe("2025-01-20T09:00:00.000Z")
  })
})
