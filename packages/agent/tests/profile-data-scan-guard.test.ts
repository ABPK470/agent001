/**
 * profile_data scan guard — the tool must refuse to profile UNION big
 * views (publish.Revenue, publish.Balances, fact.UnoTranspose and their
 * persistedView mirrors) because an unfiltered profile runs
 * COUNT_BIG(*) + per-column NULL/DISTINCT/TOP-N over every branch and
 * times out at 60s.
 *
 * Trace 2026-05-21: `profile_data(table='publish.Revenue', ...)` was
 * called as iteration-1 of a fresh run and timed out at 60s. The SQL
 * validator's `isUnsafeScan` blocks the same pattern for query_mssql
 * but profile_data builds its own SQL and bypasses it — so the guard
 * has to live in the profiler too.
 */

import { describe, expect, it } from "vitest"
import { configureAgent } from "../src/application/shell/runtime.js"
import { createProfileDataTool } from "../src/tools/mssql-profiler.js"
import { isLargeObject } from "../src/tools/mssql/validation.js"

const profileDataTool = createProfileDataTool(configureAgent({}))

describe("isLargeObject helper", () => {
  it("flags the canonical UNION big views", () => {
    expect(isLargeObject("publish.Revenue")).toBe(true)
    expect(isLargeObject("publish.Balances")).toBe(true)
    expect(isLargeObject("fact.UnoTranspose")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isLargeObject("PUBLISH.REVENUE")).toBe(true)
    expect(isLargeObject("publish.revenue")).toBe(true)
  })

  it("flags the persistedView mirrors", () => {
    expect(isLargeObject("persistedView.publish.Revenue")).toBe(true)
    expect(isLargeObject("persistedView.publish.Balances")).toBe(true)
  })

  it("does not flag small dimensions or arbitrary tables", () => {
    expect(isLargeObject("dim.Date")).toBe(false)
    expect(isLargeObject("core.Dataset")).toBe(false)
    expect(isLargeObject("publish.MappingTransactionalBankingRules")).toBe(false)
  })

  it("flags tables dynamically when a live catalog reports rowCount above threshold", () => {
    // Fake catalog: foo.HugeTable has 20M rows; foo.SmallTable has 1k.
    // The bootstrap fallback knows nothing about either, so a positive
    // result for HugeTable PROVES the catalog path is being consulted.
    const fakeCatalog = {
      getTable: (qn: string) => {
        if (qn === "foo.HugeTable") return { rowCount: 20_000_000 }
        if (qn === "foo.SmallTable") return { rowCount: 1_000 }
        return null
      },
      viewSourceRows: new Map<string, number>([["foo.MegaView", 600_000_000]]),
      tables: new Map([
        ["foo.HugeTable", { qualifiedName: "foo.HugeTable", rowCount: 20_000_000 }],
        ["foo.SmallTable", { qualifiedName: "foo.SmallTable", rowCount: 1_000 }],
      ]),
    }
    const accessor = () => fakeCatalog
    expect(isLargeObject("foo.HugeTable", accessor)).toBe(true)
    expect(isLargeObject("foo.SmallTable", accessor)).toBe(false)
    expect(isLargeObject("foo.MegaView", accessor)).toBe(true)
    // With a loaded catalog, the bootstrap fallback is bypassed — names
    // not in the catalog are NOT considered large even if they happen to
    // be in the fallback set.
    expect(isLargeObject("publish.Revenue", accessor)).toBe(false)
  })
})

describe("profile_data scan guard (deep mode)", () => {
  it("refuses publish.Revenue with an actionable hint", async () => {
    const out = await profileDataTool.execute({ table: "publish.Revenue", mode: "deep" })
    expect(out).toMatch(/refusing DEEP profile of publish\.Revenue/i)
    expect(out).toMatch(/UNION view/i)
    // Must point the agent at the safe alternatives.
    expect(out).toMatch(/mode='fast'/)
    expect(out).toMatch(/search_catalog/)
    expect(out).toMatch(/branch/i)
    expect(out).toMatch(/#temp|filtered|WHERE/i)
  })

  it("refuses fact.UnoTranspose regardless of column subset", async () => {
    const out = await profileDataTool.execute({
      table: "fact.UnoTranspose",
      mode: "deep",
      columns: ["pkMonth"],
      sample: 3,
    })
    expect(out).toMatch(/refusing DEEP profile of fact\.UnoTranspose/i)
  })

  it("refuses the persistedView mirror too", async () => {
    // Real-world spelling: persistedView.[publish.Revenue]
    const out = await profileDataTool.execute({ table: "persistedView.[publish.Revenue]", mode: "deep" })
    expect(out).toMatch(/refusing DEEP profile/i)
  })

  it("returns a parse error (NOT a guard refusal) for unqualified names", async () => {
    const out = await profileDataTool.execute({ table: "Revenue", mode: "deep" })
    expect(out).toMatch(/schema-qualified/i)
    expect(out).not.toMatch(/refusing DEEP profile/i)
  })

  it("does not refuse small dimension tables before reaching the DB layer", async () => {
    // dim.Date is not large; the guard must not fire even in deep mode. The
    // call will fail with a connection error (no DB in unit tests), which is
    // fine — what we're asserting is that the refusal message is NOT what
    // comes back.
    const out = await profileDataTool.execute({ table: "dim.Date", mode: "deep" })
    expect(out).not.toMatch(/refusing DEEP profile/i)
  })
})

describe("profile_data mode parameter", () => {
  it("declares 'fast' and 'deep' modes in its schema", () => {
    const params = profileDataTool.parameters as {
      properties: { mode?: { enum?: string[] } }
    }
    expect(params.properties.mode).toBeDefined()
    expect(params.properties.mode?.enum).toEqual(["fast", "deep"])
  })

  it("documents fast mode as the default in the tool description", () => {
    expect(profileDataTool.description).toMatch(/fast.*default/i)
    expect(profileDataTool.description).toMatch(/sys\.dm_db_partition_stats|metadata|no\s+scan/i)
  })

  it("warns that deep mode scans the table", () => {
    expect(profileDataTool.description).toMatch(/deep.*scan|slow.*large/i)
  })

  it("allows large objects in fast mode (metadata-only, no scan)", async () => {
    // Fast mode reads from sys.dm_db_partition_stats / dm_db_stats_histogram /
    // sys.indexes / INFORMATION_SCHEMA — none of which scan the data. It is
    // therefore safe on any object size; the deep-mode guard MUST NOT fire.
    const out = await profileDataTool.execute({ table: "publish.Revenue", mode: "fast" })
    expect(out).not.toMatch(/refusing to profile/i)
    // With no DB pool in unit tests we expect a SQL connection error,
    // not a guard refusal.
    expect(out).toMatch(/SQL Error|Error: /i)
  })

  it("still applies the large-object guard in deep mode", async () => {
    const out = await profileDataTool.execute({ table: "publish.Revenue", mode: "deep" })
    expect(out).toMatch(/refusing DEEP profile/i)
    // Should advertise fast mode as alternative 0.
    expect(out).toMatch(/mode='fast'/i)
  })
})
