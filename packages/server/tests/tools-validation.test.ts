/**
 * Regression tests for the guard-referenced tool validator.
 *
 * Background: guard messages, formatter warnings, and prompt sections direct
 * the model to call certain tools as fallbacks (e.g. "use export_query_to_file
 * instead of write_file"). If those tools are NOT in the agent's resolved
 * whitelist, the model loops forever — it gets blocked, is told to use a tool
 * it cannot see, and retries the only path it has. This happened in
 * production with `export_query_to_file` not being in DEFAULT_TOOLS.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { configureAgent } from "@mia/agent"
import { resolveTools } from "../src/tools.js"

const stubHost = configureAgent({})

describe("resolveTools — guard-referenced tool validation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    warnSpy?.mockRestore()
  })

  it("warns when a guard-referenced tool is missing from the whitelist", () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    // A minimal whitelist that deliberately omits export_query_to_file even
    // though query_mssql is present (so the formatter's truncation warning
    // would direct the model to a tool it cannot call).
    resolveTools(["read_file", "write_file", "query_mssql"], stubHost)
    const messages = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("export_query_to_file"))).toBe(true)
    expect(messages.some((m) => m.includes("loop"))).toBe(true)
  })

  it("does not warn when all guard-referenced tools are present", () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    resolveTools(["read_file", "write_file", "query_mssql", "export_query_to_file"], stubHost)
    const messages = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("export_query_to_file"))).toBe(false)
  })
})

describe("getAllTools — guard contract", () => {
  it("includes every guard-referenced tool", async () => {
    // getAllTools() is the single source of truth — no DB involved.
    const { getAllTools } = await import("../src/tools.js")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      resolveTools(
        getAllTools(stubHost).map((t) => t.name),
        stubHost
      )
      const messages = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(messages.filter((m) => m.startsWith("[tools] WARNING"))).toEqual([])
    } finally {
      warnSpy.mockRestore()
    }
  })
})
