/**
 * profile_data abort wiring — verifies the tool wires `request.cancel()`
 * onto `run.signal` like the other MSSQL tools, so a stuck profile is
 * cancellable instead of blocking until the 120s timeout.
 *
 * Two paths:
 *   1. Already-aborted signal → bail out before issuing any SQL.
 *   2. Signal fires mid-flight → the in-flight request's `cancel()` is
 *      invoked, unblocking the hung query.
 */

import { describe, expect, it, vi } from "vitest"
import { configureAgent, makeRunContext, type AgentHost } from "../src/runtime/runtime.js"
import { createProfileDataTool } from "../src/tools/database/mssql-profiler.js"
import { canonicalFixtureCatalog } from "./helpers/fixture-catalog.js"

function makeFixture(signal: AbortSignal | null): {
  tool: ReturnType<typeof createProfileDataTool>
  databases: Map<string, import("../src/runtime/runtime.js").MssqlEntry>
} {
  const databases = new Map<string, import("../src/runtime/runtime.js").MssqlEntry>()
  const catalogInstances = new Map<string, import("../src/tools/catalog/index.js").CatalogGraph>()
  const toolKnowledge: NonNullable<AgentHost["toolKnowledge"]> = {
    lookup: () => ({ hit: false as const, reason: "miss" as const }),
    save: () => undefined,
    renderHeader: () => ""
  }
  const host = configureAgent({ mssqlDatabases: databases, catalogInstances, toolKnowledge })
  const run = makeRunContext({ signal })
  databases.set("default", {
    config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
    pool: {
      request: () => ({ input: () => undefined, cancel: () => undefined, query: async () => ({ recordset: [] }) }),
      connected: true,
      close: async () => undefined
    } as never,
    knowledge: null
  })
  catalogInstances.set("default", canonicalFixtureCatalog())
  return { tool: createProfileDataTool(host, run), databases }
}

describe("profile_data abort wiring", () => {
  it("bails out before issuing SQL when the run signal is already aborted (fast mode)", async () => {
    const controller = new AbortController()
    controller.abort()
    const { tool, databases } = makeFixture(controller.signal)

    // Spy on request creation so we can assert NO query was ever issued.
    const requestSpy = vi.fn(() => ({
      input: () => undefined,
      cancel: () => undefined,
      query: async () => ({ recordset: [] })
    }))
    databases.set("default", {
      config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
      pool: { request: requestSpy, connected: true, close: async () => undefined } as never,
      knowledge: null
    })

    const out = (await tool.execute({ table: "dim.Date", mode: "fast" })) as string
    expect(out).toBe("Error: Tool execution cancelled")
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it("cancels the in-flight request when the signal fires mid-flight (fast mode)", async () => {
    const controller = new AbortController()
    const { tool, databases } = makeFixture(controller.signal)

    // The first request's query hangs forever until cancel() is invoked.
    // cancel() rejects the hung query, simulating mssql's cancel behaviour.
    const cancelSpy = vi.fn()
    let rejectQuery: ((e: Error) => void) | null = null
    const hungQuery = () =>
      new Promise<never>((_resolve, reject) => {
        rejectQuery = reject
      })
    databases.set("default", {
      config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
      pool: {
        request: () => ({
          input: () => undefined,
          cancel: () => {
            cancelSpy()
            rejectQuery?.(new Error("Cancelled."))
          },
          query: hungQuery
        }),
        connected: true,
        close: async () => undefined
      } as never,
      knowledge: null
    })

    const execPromise = tool.execute({ table: "dim.Date", mode: "fast" })
    // Let the first request (object identity) enter its pending query.
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    const out = (await execPromise) as string

    // The kill signal reached the in-flight request and called cancel().
    expect(cancelSpy).toHaveBeenCalled()
    // The hung query was unblocked (the run did not hang until timeout).
    expect(typeof out).toBe("string")
  })
})
