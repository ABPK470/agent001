/**
 * Dim-join NULL heuristic (Phase 6).
 *
 * If ≥ 50% of rows have a NULL in a *Name / *Description column, the
 * join key is probably wrong. Surface as a banner; do not block.
 */
import { describe, expect, it } from "vitest"

import { detectDimJoinNullRot, renderDimJoinNullBanner } from "../src/tools/mssql/dim-join-quality.js"

describe("detectDimJoinNullRot", () => {
  it("flags ClientName when more than half the rows are NULL", () => {
    const rows = [
      { pkClient: 1, ClientName: null, Revenue: 100 },
      { pkClient: 2, ClientName: null, Revenue: 90 },
      { pkClient: 3, ClientName: null, Revenue: 80 },
      { pkClient: 4, ClientName: "Acme", Revenue: 70 }
    ]
    const f = detectDimJoinNullRot(rows)
    expect(f).toHaveLength(1)
    expect(f[0].column).toBe("ClientName")
    expect(f[0].nullCount).toBe(3)
    expect(f[0].nullFraction).toBeCloseTo(0.75)
  })

  it("flags multiple offending columns sorted by descending null fraction", () => {
    const rows = [
      { pkClient: 1, ClientName: null, ProductDescription: null },
      { pkClient: 2, ClientName: "Acme", ProductDescription: null },
      { pkClient: 3, ClientName: null, ProductDescription: null },
      { pkClient: 4, ClientName: null, ProductDescription: null }
    ]
    const f = detectDimJoinNullRot(rows)
    expect(f.map((x) => x.column)).toEqual(["ProductDescription", "ClientName"])
  })

  it("does NOT flag when fewer than half the rows are NULL", () => {
    const rows = [
      { pkClient: 1, ClientName: "A", Revenue: 100 },
      { pkClient: 2, ClientName: "B", Revenue: 90 },
      { pkClient: 3, ClientName: null, Revenue: 80 },
      { pkClient: 4, ClientName: "D", Revenue: 70 }
    ]
    expect(detectDimJoinNullRot(rows)).toEqual([])
  })

  it("does NOT flag non-label columns even if heavily NULL", () => {
    const rows = [
      { pkClient: 1, MiddleInitial: null },
      { pkClient: 2, MiddleInitial: null },
      { pkClient: 3, MiddleInitial: null },
      { pkClient: 4, MiddleInitial: "Q" }
    ]
    expect(detectDimJoinNullRot(rows)).toEqual([])
  })

  it("requires at least 4 rows before the signal fires", () => {
    const rows = [{ ClientName: null }, { ClientName: null }, { ClientName: null }]
    expect(detectDimJoinNullRot(rows)).toEqual([])
  })

  it("treats undefined the same as NULL", () => {
    const rows = [
      { ClientName: undefined },
      { ClientName: undefined },
      { ClientName: undefined },
      { ClientName: "Acme" }
    ]
    expect(detectDimJoinNullRot(rows)).toHaveLength(1)
  })

  it("is case-insensitive for the Name/Description suffix", () => {
    const rows = [{ clientname: null }, { clientname: null }, { clientname: null }, { clientname: "x" }]
    expect(detectDimJoinNullRot(rows)).toHaveLength(1)
  })

  it("renderDimJoinNullBanner returns null when there are no findings", () => {
    expect(renderDimJoinNullBanner([])).toBeNull()
  })

  it("renderDimJoinNullBanner produces a percentage and a fix hint", () => {
    const banner = renderDimJoinNullBanner([
      { column: "ClientName", nullCount: 3, totalRows: 4, nullFraction: 0.75 }
    ])
    expect(banner).toMatch(/JOIN-KEY LIKELY WRONG/)
    expect(banner).toMatch(/ClientName.*3 of 4.*75%/)
    expect(banner).toMatch(/explore_mssql_schema/)
  })
})
