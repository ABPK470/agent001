/**
 * profile_data cache integration — verifies that the agent's profiler
 * consults the org-wide tool_knowledge_cache cache before hitting MSSQL, and
 * persists successful live runs back into the cache.
 *
 * The cache itself is exercised exhaustively in
 * packages/server/tests/tool-knowledge.test.ts; here we test only the
 * tool's interaction with the host-bound `lookup` / `save` / `renderHeader`
 * callbacks, including the case where there is no cache bound at all
 * (CLI / tests without a cache should fall through unchanged).
 */

import { describe, expect, it, vi } from "vitest"
import { configureAgent, makeRunContext, type AgentHost } from "../src/runtime/runtime.js"
import { createProfileDataTool } from "../src/tools/database/mssql-profiler.js"
import { canonicalFixtureCatalog } from "./helpers/fixture-catalog.js"

function makeFixture(): {
  host: AgentHost
  run: ReturnType<typeof makeRunContext>
  tool: ReturnType<typeof createProfileDataTool>
  databases: Map<string, import("../src/runtime/runtime.js").MssqlEntry>
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
  const run = makeRunContext()
  databases.set("default", {
    config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
    pool: {
      request: () => ({ cancel: () => undefined, query: async () => ({ recordset: [] }) }),
      connected: true,
      close: async () => undefined
    } as never,
    knowledge: null
  })
  catalogInstances.set("default", canonicalFixtureCatalog())
  return { host, run, toolKnowledge, tool: createProfileDataTool(host, run), databases }
}

describe("profile_data cache integration", () => {
  it("returns the cached payload + [cached from ...] header on a hit (no SQL run)", async () => {
    const { toolKnowledge, tool: profileDataTool } = makeFixture()

    const lookup = vi.fn(() => ({
      hit: true as const,
      payload: "Profile for dim.Date:\nTotal rows: 12,345\n  ...",
      ageMs: 60 * 60 * 1000,
      profiledAt: Date.UTC(2026, 4, 1)
    }))
    const save = vi.fn()
    const renderHeader = vi.fn(() => "[cached from 2026-05-01, mode=fast, ageHours=1, source=tool_knowledge_cache]")
    toolKnowledge.lookup = lookup
    toolKnowledge.save = save
    toolKnowledge.renderHeader = renderHeader

    const out = await profileDataTool.execute({ table: "dim.Date", mode: "fast" })
    expect(typeof out).toBe("string")
    expect(out).toMatch(/^\[cached from 2026-05-01/)
    expect(out).toContain("Profile for dim.Date")
    expect(lookup).toHaveBeenCalledTimes(1)
    const args = lookup.mock.calls[0]![0]
    expect(args.tool).toBe("profile_data")
    expect(args.qname).toBe("dim.date") // lowercased
    expect(args.mode).toBe("fast")
    expect(args.currentFingerprint).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })

  it("marks the table as profiled on a cache hit so the validator's big-view nudge stays satisfied", async () => {
    const { run, toolKnowledge, tool: profileDataTool } = makeFixture()
    toolKnowledge.lookup = () => ({
      hit: true as const,
      payload: "cached",
      ageMs: 1,
      profiledAt: 0
    })
    toolKnowledge.renderHeader = () => "[hdr]"
    toolKnowledge.save = vi.fn()

    await profileDataTool.execute({ table: "publish.Balances", mode: "fast" })
    expect(run.mssqlProfileCalls.has("publish.balances")).toBe(true)
  })

  it("returns the cached payload BEFORE the deep-mode scan guard — large UNION views are served from cache", async () => {
    // publish.Revenue is a known-large UNION view. Without cache, deep mode
    // is refused outright. With a cache hit, the agent should still get its
    // answer (no live deep scan happens — we're literally returning text).
    const { toolKnowledge, tool: profileDataTool } = makeFixture()
    toolKnowledge.lookup = () => ({
      hit: true as const,
      payload: "Profile for publish.Revenue:\n(deep, cached)",
      ageMs: 1,
      profiledAt: 0
    })
    toolKnowledge.renderHeader = () => "[cached]"

    const out = (await profileDataTool.execute({ table: "publish.Revenue", mode: "deep" })) as string
    expect(out).toContain("(deep, cached)")
    expect(out).not.toMatch(/refusing DEEP profile/i)
  })

  it("falls through to live execution on cache miss, then persists the rendered result", async () => {
    const { toolKnowledge, tool: profileDataTool, databases } = makeFixture()

    toolKnowledge.lookup = vi.fn(() => ({ hit: false as const, reason: "miss" as const }))
    const save = vi.fn()
    toolKnowledge.save = save
    toolKnowledge.renderHeader = () => "ignored"

    // Patch the stubbed pool so runFastProfile returns a non-error string.
    // We can't easily emulate runFastProfile's full SQL flow, so instead
    // we stub out the request handler to return enough recordsets that
    // runFastProfile completes and we capture whatever it emits.
    const fakeQuery = (sqlText: string): Promise<{ recordset: Array<Record<string, unknown>> }> => {
      const text = sqlText.toLowerCase()
      if (text.includes("dm_db_partition_stats")) return Promise.resolve({ recordset: [{ row_count: 100 }] })
      if (text.includes("information_schema.columns")) {
        return Promise.resolve({
          recordset: [
            {
              COLUMN_NAME: "Id",
              DATA_TYPE: "int",
              IS_NULLABLE: "NO",
              CHARACTER_MAXIMUM_LENGTH: null
            },
            {
              COLUMN_NAME: "Name",
              DATA_TYPE: "varchar",
              IS_NULLABLE: "YES",
              CHARACTER_MAXIMUM_LENGTH: 50
            }
          ]
        })
      }
      return Promise.resolve({ recordset: [] })
    }
    databases.set("default", {
      config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
      pool: {
        request: () => ({ input: () => undefined, cancel: () => undefined, query: fakeQuery }),
        connected: true,
        close: async () => undefined
      } as never,
      knowledge: null
    })

    const out = (await profileDataTool.execute({ table: "dim.Date", mode: "fast" })) as string
    expect(typeof out).toBe("string")
    expect(out).not.toMatch(/^SQL Error/)
    expect(out).not.toMatch(/^Error/)
    // The header must NOT be prepended on a live run.
    expect(out).not.toMatch(/^\[cached/)

    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0]![0]
    expect(saved.tool).toBe("profile_data")
    expect(saved.qname).toBe("dim.date")
    expect(saved.mode).toBe("fast")
    expect(saved.payload).toBe(out)
    expect(saved.fingerprint).toBeTruthy()
  })

  it("does NOT persist a SQL-error result to the cache (avoids poisoning)", async () => {
    const { toolKnowledge, tool: profileDataTool, databases } = makeFixture()
    toolKnowledge.lookup = () => ({ hit: false as const, reason: "miss" as const })
    const save = vi.fn()
    toolKnowledge.save = save

    // Stub so getPool resolves but runFastProfile throws -> returns "SQL Error: ..."
    databases.set("default", {
      config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
      pool: {
        request: () => ({
          input: () => undefined,
          cancel: () => undefined,
          query: () => Promise.reject(new Error("boom"))
        }),
        connected: true,
        close: async () => undefined
      } as never,
      knowledge: null
    })

    const out = (await profileDataTool.execute({ table: "dim.Date", mode: "fast" })) as string
    expect(out).toMatch(/^SQL Error/)
    expect(save).not.toHaveBeenCalled()
  })

  it("falls through gracefully when no cache is bound (CLI / root runtime)", async () => {
    const { toolKnowledge, tool: profileDataTool } = makeFixture()
    // No lookup/save/renderHeader bound — defaults are null.
    toolKnowledge.lookup = null as unknown as NonNullable<AgentHost["toolKnowledge"]>["lookup"]
    toolKnowledge.save = null as unknown as NonNullable<AgentHost["toolKnowledge"]>["save"]

    // Cheap pool stub that returns an empty recordset — runFastProfile
    // will emit "No columns found ..." which the tool returns as a string.
    const out = (await profileDataTool.execute({ table: "dim.Date", mode: "fast" })) as string
    expect(typeof out).toBe("string")
    // Whether the result is an error string or a partial render, the key
    // assertion is that the absence of cache wiring did not throw.
  })

  it("skips the cache when the catalog has no entry for the qname (no fingerprint = no cache)", async () => {
    const { toolKnowledge, tool: profileDataTool } = makeFixture()
    const lookup = vi.fn(() => ({
      hit: true as const,
      payload: "should-not-be-used",
      ageMs: 0,
      profiledAt: 0
    }))
    toolKnowledge.lookup = lookup

    // mystery.Unknown does not exist in the fixture catalog -> fingerprint=null
    // -> tryServeFromCache returns null before invoking lookup.
    await profileDataTool.execute({ table: "mystery.Unknown", mode: "fast" })
    expect(lookup).not.toHaveBeenCalled()
  })
})
