/**
 * Freeze-window evaluator tests — Phase 0 governance coverage.
 *
 * Tests the registry install/list cycle, active-window bracketing, and
 * the unknown-id soft-handling guarantee (typo safety).
 */

import { describe, expect, it } from "vitest"
import {
    evaluateFreezeWindows,
    installFreezeWindowRegistry,
    listFreezeWindows,
    type FreezeWindowDefinition,
} from "../../sync/src/governance/freeze-windows.js"

const WINDOW_A: FreezeWindowDefinition = {
  id:          "month-end",
  displayName: "Month-end reporting",
  description: "Reporting team locks tables Mon–Fri of EOM week.",
  startsAt:    "2025-01-27T00:00:00.000Z",
  endsAt:      "2025-02-01T00:00:00.000Z",
}

const WINDOW_B: FreezeWindowDefinition = {
  id:          "release-week",
  displayName: "Release week",
  description: "",
  startsAt:    "2026-06-01T00:00:00.000Z",
  endsAt:      "2026-06-08T00:00:00.000Z",
}

describe("freeze-windows", () => {
  it("listFreezeWindows reflects the installed registry", () => {
    installFreezeWindowRegistry([WINDOW_A, WINDOW_B])
    const list = listFreezeWindows()
    expect(list.map((w) => w.id).sort()).toEqual(["month-end", "release-week"])
  })

  it("returns inactive when no ids are referenced", () => {
    installFreezeWindowRegistry([WINDOW_A])
    const ev = evaluateFreezeWindows([], new Date("2025-01-29T12:00:00.000Z"))
    expect(ev.active).toBe(false)
    expect(ev.matched).toHaveLength(0)
    expect(ev.unknownIds).toHaveLength(0)
  })

  it("marks a window active when `now` falls inside [start, end)", () => {
    installFreezeWindowRegistry([WINDOW_A])
    const ev = evaluateFreezeWindows(["month-end"], new Date("2025-01-29T12:00:00.000Z"))
    expect(ev.active).toBe(true)
    expect(ev.activeWindows.map((w) => w.id)).toEqual(["month-end"])
  })

  it("marks a window inactive when `now` is at the exclusive end boundary", () => {
    installFreezeWindowRegistry([WINDOW_A])
    const ev = evaluateFreezeWindows(["month-end"], new Date("2025-02-01T00:00:00.000Z"))
    expect(ev.active).toBe(false)
    expect(ev.matched).toHaveLength(1)
    expect(ev.activeWindows).toHaveLength(0)
  })

  it("marks a window active at the inclusive start boundary", () => {
    installFreezeWindowRegistry([WINDOW_A])
    const ev = evaluateFreezeWindows(["month-end"], new Date("2025-01-27T00:00:00.000Z"))
    expect(ev.active).toBe(true)
  })

  it("collects unknown ids without blocking — typo safety", () => {
    installFreezeWindowRegistry([WINDOW_A])
    const ev = evaluateFreezeWindows(["month-end", "typo-id"], new Date("2025-01-29T12:00:00.000Z"))
    expect(ev.active).toBe(true)
    expect(ev.unknownIds).toEqual(["typo-id"])
  })

  it("returns active when ANY referenced window is active", () => {
    installFreezeWindowRegistry([WINDOW_A, WINDOW_B])
    const ev = evaluateFreezeWindows(["release-week", "month-end"], new Date("2025-01-29T12:00:00.000Z"))
    expect(ev.active).toBe(true)
    expect(ev.activeWindows.map((w) => w.id)).toEqual(["month-end"])
  })
})
