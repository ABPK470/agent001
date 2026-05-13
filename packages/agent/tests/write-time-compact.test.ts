/**
 * Write-time tool-result compaction — locks the threshold + recall hint
 * behaviour added in `feat/prompt-token-diet` (Phase 4).
 */

import { describe, expect, it } from "vitest"
import { compactAtWriteTime } from "../src/context/context-management/write-time-compact.js"

describe("compactAtWriteTime", () => {
  it("returns small results unchanged regardless of tool", () => {
    const small = "x".repeat(1024)
    expect(compactAtWriteTime("read_attachment", small)).toBe(small)
    expect(compactAtWriteTime("read_file",       small)).toBe(small)
  })

  it("returns large results unchanged for tools NOT in the eager-compact set", () => {
    const big = "x".repeat(64 * 1024)
    expect(compactAtWriteTime("query_mssql",       big)).toBe(big)
    expect(compactAtWriteTime("inspect_definition", big)).toBe(big)
  })

  it("trims oversized read_attachment results to head + tail with a recall hint", () => {
    const head = "HEAD-MARKER"
    const tail = "TAIL-MARKER"
    const big  = head + "x".repeat(64 * 1024) + tail
    const out  = compactAtWriteTime("read_attachment", big)
    expect(out.length).toBeLessThan(big.length)
    expect(out.startsWith(head)).toBe(true)
    expect(out.endsWith(tail)).toBe(true)
    expect(out).toMatch(/\[truncated at write time/)
    expect(out).toMatch(/re-call read_attachment with offset=/)
  })

  it("emits a tool-specific recall hint", () => {
    const big = "y".repeat(40 * 1024)
    expect(compactAtWriteTime("read_file",   big)).toMatch(/re-call read_file with startLine\/endLine/)
    expect(compactAtWriteTime("run_command", big)).toMatch(/re-run with a more specific filter/)
    expect(compactAtWriteTime("fetch_url",   big)).toMatch(/re-fetch with a narrower selector/)
  })
})
