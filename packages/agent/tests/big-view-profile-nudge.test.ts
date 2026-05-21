/**
 * Big-view-without-profile_data nudge (Phase 3).
 *
 * Doctrine: queries against publish.Revenue / publish.Balances /
 * fact.UnoTranspose should be preceded by `profile_data` on the same view
 * in the current run. The trace 2026-05-21 showed `profile_data` used once
 * in 17 iterations — the model treats it as optional.
 *
 * Detector is stateless; the per-run "already profiled" set is passed in
 * by the caller. These tests inject the set directly.
 */
import { describe, expect, it } from "vitest"

import {
    detectBigViewWithoutProfile,
    getQueryWarnings,
} from "../src/tools/mssql/validation.js"

describe("detectBigViewWithoutProfile", () => {
  it("flags publish.Revenue when not yet profiled", () => {
    const query = "SELECT pkClient FROM publish.Revenue WHERE pkMonth = 202501"
    expect(detectBigViewWithoutProfile(query, new Set())).toEqual(["publish.revenue"])
  })

  it("flags publish.Balances independently", () => {
    const query = "SELECT pkAccount FROM publish.Balances WHERE pkMonth = 202501"
    expect(detectBigViewWithoutProfile(query, new Set())).toEqual(["publish.balances"])
  })

  it("flags fact.UnoTranspose", () => {
    const query = "SELECT * FROM fact.UnoTranspose WHERE pkMonth = 202501"
    expect(detectBigViewWithoutProfile(query, new Set())).toEqual(["fact.unotranspose"])
  })

  it("does not flag once the view has been profiled (case-insensitive)", () => {
    const query = "SELECT pkClient FROM publish.Revenue WHERE pkMonth = 202501"
    expect(detectBigViewWithoutProfile(query, new Set(["publish.revenue"]))).toEqual([])
  })

  it("does not flag non-big views even when profiledTables is empty", () => {
    const query = "SELECT * FROM dim.Client"
    expect(detectBigViewWithoutProfile(query, new Set())).toEqual([])
  })

  it("returns multiple triggers when several big views are touched untouched", () => {
    const query = [
      "SELECT r.pkClient FROM publish.Revenue r",
      "JOIN publish.Balances b ON b.pkClient = r.pkClient",
      "WHERE r.pkMonth = 202501",
    ].join("\n")
    expect(detectBigViewWithoutProfile(query, new Set())).toEqual([
      "publish.revenue",
      "publish.balances",
    ])
  })

  it("treats null profiledTables as 'unknown — surface the nudge'", () => {
    const query = "SELECT pkClient FROM publish.Revenue WHERE pkMonth = 202501"
    expect(detectBigViewWithoutProfile(query, null)).toEqual(["publish.revenue"])
  })

  it("getQueryWarnings includes the profile-first banner when profiledTables is empty", () => {
    const query = "SELECT pkClient FROM publish.Revenue WHERE pkMonth = 202501"
    const banner = getQueryWarnings(query, {
      // Disable lineage detector for this test by handing it a null catalog.
      lineageAccessor: () => null,
      profiledTables: new Set(),
    })
    expect(banner).not.toBeNull()
    expect(banner).toMatch(/profile-first: publish\.revenue/)
    expect(banner).toMatch(/profile_data/)
  })

  it("getQueryWarnings omits the profile-first banner once the view is profiled", () => {
    const query = "SELECT pkClient FROM publish.Revenue WHERE pkMonth = 202501"
    const banner = getQueryWarnings(query, {
      lineageAccessor: () => null,
      profiledTables: new Set(["publish.revenue"]),
    })
    expect(banner).toBeNull()
  })
})
