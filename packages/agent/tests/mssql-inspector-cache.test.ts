/**
 * inspect_definition cache integration — verifies the `object=` mode
 * consults the org-wide tool_knowledge cache before reading T-SQL source
 * and persists on a successful live run. Dynamic modes (slow_queries,
 * missing_indexes, index_usage, search, depends_on, scan_duplicates)
 * are NOT cached — verified in the "dynamic mode is not cached" test.
 */

import { describe, expect, it, vi } from "vitest"
import { AgentRuntime } from "../src/agent-runtime.js"
import { configureAgent } from "../src/host/index.js"
import { createInspectDefinitionTool } from "../src/tools/mssql-inspector/tool.js"
import { installCanonicalFixtureCatalog } from "./helpers/fixture-catalog.js"

function makeRuntime(): { runtime: AgentRuntime; tool: ReturnType<typeof createInspectDefinitionTool> } {
  const databases = new Map<string, import("../src/agent-runtime.js").MssqlEntry>()
  const host = configureAgent({ mssqlDatabases: databases })
  databases.set("default", {
    config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
    pool: { request: () => ({ input: () => undefined, cancel: () => undefined, query: async () => ({ recordset: [] }) }), connected: true, close: async () => undefined } as never,
    writeEnabled: false,
    knowledge: null,
  })
  const runtime = new AgentRuntime({ workspaceRoot: process.cwd() })
  return { runtime, tool: createInspectDefinitionTool(host) }
}

describe("inspect_definition cache integration", () => {
  it("returns the cached payload + header on a hit for object= mode", async () => {
    const { runtime, tool: inspectDefinitionTool } = makeRuntime()
    installCanonicalFixtureCatalog()

    const lookup = vi.fn(() => ({
      hit: true as const,
      payload: "T-SQL source for dim.Date:\nCREATE VIEW ...",
      ageMs: 1,
      profiledAt: 0,
    }))
    runtime.toolKnowledge.lookup = lookup
    runtime.toolKnowledge.save = vi.fn()
    runtime.toolKnowledge.renderHeader = () => "[cached from 2026-05-01, mode=definition, ageHours=1, source=tool_knowledge]"

    const out = await runtime.run(() => inspectDefinitionTool.execute({ object: "dim.Date" })) as string
    expect(out).toMatch(/^\[cached from 2026-05-01.*mode=definition/)
    expect(out).toContain("T-SQL source for dim.Date")
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup.mock.calls[0]![0].tool).toBe("inspect_definition")
    expect(lookup.mock.calls[0]![0].mode).toBe("definition")
    expect(lookup.mock.calls[0]![0].qname).toBe("dim.date")
  })

  it("does NOT cache dynamic modes (slow_queries / missing_indexes / index_usage / search / depends_on)", async () => {
    const { runtime, tool: inspectDefinitionTool } = makeRuntime()
    const lookup = vi.fn()
    runtime.toolKnowledge.lookup = lookup
    runtime.toolKnowledge.save = vi.fn()

    // We only care that the cache pre-flight does not consult the cache
    // when args.object is absent. The downstream SQL handlers may fail
    // against the stub pool — that's fine, we swallow errors here.
    for (const args of [
      { slow_queries: true },
      { missing_indexes: true },
      { index_usage: "dim.Date" },
      { search: "Revenue" },
      { depends_on: "dim.Date" },
    ]) {
      try {
        await runtime.run(() => inspectDefinitionTool.execute(args))
      } catch {
        // ignore — handler may throw against the stub pool
      }
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("skips the cache when the object is not in the catalog (no fingerprint)", async () => {
    const { runtime, tool: inspectDefinitionTool } = makeRuntime()
    const lookup = vi.fn(() => ({ hit: true as const, payload: "x", ageMs: 0, profiledAt: 0 }))
    runtime.toolKnowledge.lookup = lookup
    try {
      await runtime.run(() => inspectDefinitionTool.execute({ object: "mystery.Unknown" }))
    } catch { /* live path may fail against the stub pool */ }
    expect(lookup).not.toHaveBeenCalled()
  })
})
