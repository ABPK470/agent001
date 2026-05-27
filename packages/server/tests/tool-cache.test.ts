/**
 * Tool-cache tests \u2014 content-addressed deterministic-output reuse across runs.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let scratch: string
const ORIGINAL_TMPDIR = process.env["TMPDIR"]

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "mia-tool-cache-test-"))
  // Redirect tmpdir() so the cache root is isolated per test.
  process.env["TMPDIR"] = scratch
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  if (ORIGINAL_TMPDIR === undefined) delete process.env["TMPDIR"]
  else process.env["TMPDIR"] = ORIGINAL_TMPDIR
})

describe("tool-cache", () => {
  it("memoises deterministic compute() across calls within a session", async () => {
    // Re-import after env change so getToolCacheRoot() resolves under scratch.
    const { getOrCompute } = await import("../src/adapters/persistence/tool-cache.js")
    let calls = 0
    const compute = async () => { calls++; return { hello: "world" } }

    const a = await getOrCompute({ tool: "fetch_url", input: { url: "https://example.com" }, sessionId: "sess-1", compute })
    const b = await getOrCompute({ tool: "fetch_url", input: { url: "https://example.com" }, sessionId: "sess-1", compute })

    expect(calls).toBe(1)
    expect(a.cached).toBe(false)
    expect(b.cached).toBe(true)
    expect(b.value).toEqual({ hello: "world" })
  })

  it("partitions by sessionId so two sessions cannot poison each other", async () => {
    const { getOrCompute } = await import("../src/adapters/persistence/tool-cache.js")
    let aCalls = 0, bCalls = 0
    const computeA = async () => { aCalls++; return "alice-result" }
    const computeB = async () => { bCalls++; return "bob-result" }

    await getOrCompute({ tool: "fetch_url", input: { url: "https://x.test" }, sessionId: "sess-alice", compute: computeA })
    await getOrCompute({ tool: "fetch_url", input: { url: "https://x.test" }, sessionId: "sess-bob", compute: computeB })

    // Same input, different session \u2014 each computes independently.
    expect(aCalls).toBe(1)
    expect(bCalls).toBe(1)

    // Repeat hits the cache for each session independently.
    const aHit = await getOrCompute({ tool: "fetch_url", input: { url: "https://x.test" }, sessionId: "sess-alice", compute: computeA })
    const bHit = await getOrCompute({ tool: "fetch_url", input: { url: "https://x.test" }, sessionId: "sess-bob", compute: computeB })
    expect(aHit.value).toBe("alice-result")
    expect(bHit.value).toBe("bob-result")
    expect(aCalls).toBe(1)
    expect(bCalls).toBe(1)
  })

  it("canonicalises input so {a:1,b:2} and {b:2,a:1} hit the same key", async () => {
    const { getOrCompute } = await import("../src/adapters/persistence/tool-cache.js")
    let calls = 0
    const compute = async () => { calls++; return calls }
    await getOrCompute({ tool: "schema_dump", input: { a: 1, b: 2 }, sessionId: "s", compute })
    const second = await getOrCompute({ tool: "schema_dump", input: { b: 2, a: 1 }, sessionId: "s", compute })
    expect(calls).toBe(1)
    expect(second.cached).toBe(true)
  })

  it("expired entries are treated as misses and removable by cleanup", async () => {
    const { getOrCompute, readCache, cleanupExpiredCache, getCacheStats } = await import("../src/adapters/persistence/tool-cache.js")
    let calls = 0
    const compute = async () => { calls++; return "v" }

    await getOrCompute({ tool: "t", input: { k: 1 }, sessionId: "s", ttlMs: 10, compute })
    await new Promise((r) => setTimeout(r, 25))

    // Direct read: expired \u2192 null
    const stale = await readCache({ tool: "t", input: { k: 1 }, sessionId: "s" })
    expect(stale).toBeNull()

    // getOrCompute re-runs the computation and replaces the entry.
    const refreshed = await getOrCompute({ tool: "t", input: { k: 1 }, sessionId: "s", ttlMs: 10, compute })
    expect(refreshed.cached).toBe(false)
    expect(calls).toBe(2)

    // Cleanup removes anything that has aged past expiresAt.
    await new Promise((r) => setTimeout(r, 25))
    const before = await getCacheStats()
    expect(before.files).toBeGreaterThan(0)
    const cleaned = await cleanupExpiredCache()
    expect(cleaned.removed).toBeGreaterThan(0)
    const after = await getCacheStats()
    expect(after.files).toBe(0)
  })

  it("rejects unsafe sessionIds so cache cannot escape its partition", async () => {
    const { writeCache, readCache } = await import("../src/adapters/persistence/tool-cache.js")
    // A sessionId containing path-traversal characters must be rejected
    // outright \u2014 throwing loudly is preferred over silently mapping to a
    // shared "invalid" bucket, since the latter collapsed every malformed
    // caller into one shared partition (the bug class fixed in
    // wiring-contracts.test.ts B-AUDIT). identity.ts:resolveSession()
    // guarantees real callers always have a clean sid.
    await expect(
      writeCache({ tool: "t", input: 1, sessionId: "../escape", value: "evil" }),
    ).rejects.toThrow(/invalid sessionId/)
    await expect(
      readCache({ tool: "t", input: 1, sessionId: "../escape" }),
    ).rejects.toThrow(/invalid sessionId/)
    // An empty / whitespace sessionId is also rejected (no shared bucket).
    await expect(
      writeCache({ tool: "t", input: 1, sessionId: "", value: "evil" }),
    ).rejects.toThrow(/invalid sessionId/)
    // A well-formed neighbouring session never sees any leaked entry.
    const other = await readCache<string>({ tool: "t", input: 1, sessionId: "real-session" })
    expect(other).toBeNull()
  })

  it("clearSessionCache removes only the targeted session", async () => {
    const { getOrCompute, clearSessionCache, getCacheStats } = await import("../src/adapters/persistence/tool-cache.js")
    await getOrCompute({ tool: "t", input: 1, sessionId: "keep-me", compute: async () => 1 })
    await getOrCompute({ tool: "t", input: 1, sessionId: "drop-me", compute: async () => 2 })

    const removed = await clearSessionCache("drop-me")
    expect(removed.removed).toBeGreaterThan(0)

    const stats = await getCacheStats()
    expect(stats.sessions).toBe(1)
    expect(stats.files).toBe(1)
  })
})
