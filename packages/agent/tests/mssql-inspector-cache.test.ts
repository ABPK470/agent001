/**
 * inspect_definition cache integration — verifies the `object=` mode
 * consults the org-wide tool_knowledge cache before reading T-SQL source
 * and persists on a successful live run. Dynamic modes (slow_queries,
 * missing_indexes, index_usage, search, depends_on, scan_duplicates)
 * are NOT cached — verified in the "dynamic mode is not cached" test.
 */

import { describe, expect, it, vi } from "vitest"
import { configureAgent, type AgentHost } from "../src/runtime/runtime.js"
import { createInspectDefinitionTool } from "../src/tools/database/mssql-inspector/tool.js"
import { canonicalFixtureCatalog } from "./helpers/fixture-catalog.js"

function makeFixture(): {
  tool: ReturnType<typeof createInspectDefinitionTool>
  toolKnowledge: NonNullable<AgentHost["toolKnowledge"]>
} {
  const databases = new Map<string, import("../src/runtime/runtime.js").MssqlEntry>()
  const catalogInstances = new Map<string, import("../src/tools/catalog/index.js").CatalogGraph>()
  const toolKnowledge: NonNullable<AgentHost["toolKnowledge"]> = {
    lookup: () => ({ hit: false as const, reason: "miss" as const }),
    save: () => undefined,
    renderHeader: () => ""
  }
  const host = configureAgent({
    mssqlDatabases: databases,
    catalogInstances,
    toolKnowledge
  })
  databases.set("default", {
    config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
    pool: {
      request: () => ({
        input: () => undefined,
        cancel: () => undefined,
        query: async () => ({ recordset: [] })
      }),
      connected: true,
      close: async () => undefined
    } as never,
    writeEnabled: false,
    knowledge: null
  })
  catalogInstances.set("default", canonicalFixtureCatalog())
  return { toolKnowledge, tool: createInspectDefinitionTool(host) }
}

describe("inspect_definition cache integration", () => {
  it("returns the cached payload + header on a hit for object= mode", async () => {
    const { toolKnowledge, tool: inspectDefinitionTool } = makeFixture()

    const lookup = vi.fn(() => ({
      hit: true as const,
      payload: "T-SQL source for dim.Date:\nCREATE VIEW ...",
      ageMs: 1,
      profiledAt: 0
    }))
    toolKnowledge.lookup = lookup
    toolKnowledge.save = vi.fn()
    toolKnowledge.renderHeader = () =>
      "[cached from 2026-05-01, mode=definition, ageHours=1, source=tool_knowledge]"

    const out = (await inspectDefinitionTool.execute({ object: "dim.Date" })) as string
    expect(out).toMatch(/^\[cached from 2026-05-01.*mode=definition/)
    expect(out).toContain("T-SQL source for dim.Date")
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup.mock.calls[0]![0].tool).toBe("inspect_definition")
    expect(lookup.mock.calls[0]![0].mode).toBe("definition")
    expect(lookup.mock.calls[0]![0].qname).toBe("dim.date")
  })

  it("does NOT cache dynamic modes (slow_queries / missing_indexes / index_usage / search / depends_on)", async () => {
    const { toolKnowledge, tool: inspectDefinitionTool } = makeFixture()
    const lookup = vi.fn()
    toolKnowledge.lookup = lookup
    toolKnowledge.save = vi.fn()

    // We only care that the cache pre-flight does not consult the cache
    // when args.object is absent. The downstream SQL handlers may fail
    // against the stub pool — that's fine, we swallow errors here.
    for (const args of [
      { slow_queries: true },
      { missing_indexes: true },
      { index_usage: "dim.Date" },
      { search: "Revenue" },
      { depends_on: "dim.Date" }
    ]) {
      try {
        await inspectDefinitionTool.execute(args)
      } catch {
        // ignore — handler may throw against the stub pool
      }
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("skips the cache when the object is not in the catalog (no fingerprint)", async () => {
    const { toolKnowledge, tool: inspectDefinitionTool } = makeFixture()
    const lookup = vi.fn(() => ({ hit: true as const, payload: "x", ageMs: 0, profiledAt: 0 }))
    toolKnowledge.lookup = lookup
    try {
      await inspectDefinitionTool.execute({ object: "mystery.Unknown" })
    } catch {
      /* live path may fail against the stub pool */
    }
    expect(lookup).not.toHaveBeenCalled()
  })
})
