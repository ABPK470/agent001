/**
 * explore_mssql_schema cache integration (Gap 1).
 *
 * Verifies that:
 *   - table='schema.X' consults `tool_knowledge` BEFORE hitting MSSQL.
 *   - On a hit (own bucket) the cached payload + header is returned.
 *   - On a miss, the profile_data fast cache is cross-served (with a
 *     small banner) so the FIRST run's profile_data also satisfies the
 *     SECOND run's explore_mssql_schema for the same qname.
 *   - On a full miss, the live result is persisted under
 *     ("explore_mssql_schema", qname, "columns").
 *   - Falls through gracefully when no cache is bound or the table is
 *     not in the catalog (no fingerprint).
 */

import { describe, expect, it, vi } from "vitest"
import { AgentRuntime } from "../src/agent-runtime.js"
import { configureAgent } from "../src/host/index.js"
import { createMssqlSchemaTool } from "../src/tools/mssql/tools.js"
import { installCanonicalFixtureCatalog } from "./helpers/fixture-catalog.js"

function makeRuntime(query?: (sql: string) => Promise<{ recordset: unknown[]; recordsets: unknown[][]; rowsAffected: number[] }>): { runtime: AgentRuntime; tool: ReturnType<typeof createMssqlSchemaTool> } {
  const databases = new Map<string, import("../src/agent-runtime.js").MssqlEntry>()
  const host = configureAgent({ mssqlDatabases: databases })
  databases.set("default", {
    config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
    pool: {
      request: () => ({
        input: () => undefined,
        cancel: () => undefined,
        query: query ?? (async () => ({ recordset: [], recordsets: [[]], rowsAffected: [0] })),
      }),
      connected: true,
      close: async () => undefined,
    } as never,
    writeEnabled: false,
    knowledge: null,
  })
  const runtime = new AgentRuntime({ workspaceRoot: process.cwd() })
  return { runtime, tool: createMssqlSchemaTool(host) }
}

describe("explore_mssql_schema cache integration (Gap 1)", () => {
  it("returns cached payload + header on a hit (own bucket: explore_mssql_schema, columns)", async () => {
    const { runtime, tool: mssqlSchemaTool } = makeRuntime()
    installCanonicalFixtureCatalog()

    const lookup = vi.fn((args: { tool: string; mode?: string }) => {
      if (args.tool === "explore_mssql_schema" && args.mode === "columns") {
        return { hit: true as const, payload: "Columns for publish.Revenue:\npkClient int\n...", ageMs: 1, profiledAt: 0 }
      }
      return { hit: false as const, reason: "miss" as const }
    })
    runtime.toolKnowledge.lookup = lookup
    runtime.toolKnowledge.save = vi.fn()
    runtime.toolKnowledge.renderHeader = () => "[cached from 2026-05-22, mode=columns, ageHours=1, source=tool_knowledge]"

    const out = await runtime.run(() => mssqlSchemaTool.execute({ table: "publish.Revenue" })) as string
    expect(out).toMatch(/^\[cached from 2026-05-22.*mode=columns/)
    expect(out).toContain("Columns for publish.Revenue")
    expect(lookup).toHaveBeenCalled()
    expect(lookup.mock.calls[0]![0].tool).toBe("explore_mssql_schema")
    expect(lookup.mock.calls[0]![0].qname).toBe("publish.revenue")
    expect(lookup.mock.calls[0]![0].mode).toBe("columns")
    expect(runtime.toolKnowledge.save).not.toHaveBeenCalled()
  })

  it("cross-serves from profile_data(fast) cache when own bucket misses", async () => {
    const { runtime, tool: mssqlSchemaTool } = makeRuntime()
    installCanonicalFixtureCatalog()

    const lookup = vi.fn((args: { tool: string; mode?: string }) => {
      if (args.tool === "explore_mssql_schema") return { hit: false as const, reason: "miss" as const }
      if (args.tool === "profile_data" && args.mode === "fast") {
        return {
          hit: true as const,
          payload: "Profile for publish.Revenue:\nTotal rows: 60M\nColumns:\npkClient int ...",
          ageMs: 1,
          profiledAt: 0,
        }
      }
      return { hit: false as const, reason: "miss" as const }
    })
    runtime.toolKnowledge.lookup = lookup
    runtime.toolKnowledge.save = vi.fn()
    runtime.toolKnowledge.renderHeader = () => "[hdr]"

    const out = await runtime.run(() => mssqlSchemaTool.execute({ table: "publish.Revenue" })) as string
    expect(out).toContain("cross-served from profile_data(fast) cache")
    expect(out).toContain("Profile for publish.Revenue")
    // Both buckets consulted, own first then profile_data
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(lookup.mock.calls[0]![0].tool).toBe("explore_mssql_schema")
    expect(lookup.mock.calls[1]![0].tool).toBe("profile_data")
    expect(lookup.mock.calls[1]![0].mode).toBe("fast")
    // Cross-serve must NOT re-persist (avoid duplicating data across buckets)
    expect(runtime.toolKnowledge.save).not.toHaveBeenCalled()
  })

  it("falls through to live execution on full miss, then persists the result", async () => {
    const fakeQuery = (text: string): Promise<{ recordset: Array<Record<string, unknown>>; recordsets: Array<Array<Record<string, unknown>>>; rowsAffected: number[] }> => {
      if (text.toLowerCase().includes("information_schema.columns")) {
        const rs = [
          { TABLE_SCHEMA: "publish", COLUMN_NAME: "pkClient", DATA_TYPE: "int", IS_NULLABLE: "NO", CHARACTER_MAXIMUM_LENGTH: null, COLUMN_DEFAULT: null, IS_PRIMARY_KEY: "NO", FK_REFERENCES: null },
          { TABLE_SCHEMA: "publish", COLUMN_NAME: "pkMonth", DATA_TYPE: "int", IS_NULLABLE: "NO", CHARACTER_MAXIMUM_LENGTH: null, COLUMN_DEFAULT: null, IS_PRIMARY_KEY: "NO", FK_REFERENCES: null },
        ]
        return Promise.resolve({ recordset: rs, recordsets: [rs], rowsAffected: [rs.length] })
      }
      return Promise.resolve({ recordset: [], recordsets: [[]], rowsAffected: [0] })
    }
    const { runtime, tool: mssqlSchemaTool } = makeRuntime(fakeQuery as never)
    installCanonicalFixtureCatalog()

    runtime.toolKnowledge.lookup = vi.fn(() => ({ hit: false as const, reason: "miss" as const }))
    const save = vi.fn()
    runtime.toolKnowledge.save = save
    runtime.toolKnowledge.renderHeader = () => "ignored"

    const out = await runtime.run(() => mssqlSchemaTool.execute({ table: "publish.Revenue" })) as string
    expect(out).toMatch(/^Columns for publish\.Revenue/)
    expect(out).not.toMatch(/^\[cached/)

    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0]![0]
    expect(saved.tool).toBe("explore_mssql_schema")
    expect(saved.qname).toBe("publish.revenue")
    expect(saved.mode).toBe("columns")
    expect(saved.payload).toBe(out)
    expect(saved.fingerprint).toBeTruthy()
  })

  it("falls through gracefully when no cache is bound (CLI / root runtime)", async () => {
    const { runtime, tool: mssqlSchemaTool } = makeRuntime()
    installCanonicalFixtureCatalog()
    expect(runtime.toolKnowledge.lookup).toBeNull()
    expect(runtime.toolKnowledge.save).toBeNull()

    // Stub returns empty rows so the tool emits the "No columns found" string.
    const out = await runtime.run(() => mssqlSchemaTool.execute({ table: "publish.Revenue" })) as string
    expect(typeof out).toBe("string")
  })

  it("skips the cache when the table has no schema prefix (cannot build a stable qname)", async () => {
    const { runtime, tool: mssqlSchemaTool } = makeRuntime()
    installCanonicalFixtureCatalog()
    const lookup = vi.fn(() => ({ hit: true as const, payload: "x", ageMs: 0, profiledAt: 0 }))
    runtime.toolKnowledge.lookup = lookup
    try {
      await runtime.run(() => mssqlSchemaTool.execute({ table: "Revenue" }))
    } catch { /* live path may fail against the stub pool */ }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("skips the cache when the qname is not in the catalog (no fingerprint)", async () => {
    const { runtime, tool: mssqlSchemaTool } = makeRuntime()
    installCanonicalFixtureCatalog()
    const lookup = vi.fn(() => ({ hit: true as const, payload: "x", ageMs: 0, profiledAt: 0 }))
    runtime.toolKnowledge.lookup = lookup
    try {
      await runtime.run(() => mssqlSchemaTool.execute({ table: "mystery.Unknown" }))
    } catch { /* live path may fail against the stub pool */ }
    expect(lookup).not.toHaveBeenCalled()
  })
})
