/**
 * Tests for the `note` tool — verifies the base (unbound) tool returns a
 * clear error, and `bindNoteTool` wraps the handler with input validation
 * and result formatting.
 *
 * These tests cover the shape/contract of the tool independent of memory
 * storage; the server-side persistence is covered by
 * memory-ingest-note.test.ts in the server package.
 */

import { describe, expect, it, vi } from "vitest"
import { bindNoteTool, NOTE_CATEGORIES, noteTool } from "../src/tools/note.js"

describe("noteTool (base, unbound)", () => {
  it("declares the documented schema", () => {
    expect(noteTool.name).toBe("note")
    const props = noteTool.parameters.properties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(["category", "claim", "evidence", "subject"])
    expect(noteTool.parameters.required).toEqual(["subject", "claim"])
  })

  it("returns a not-bound error from the default execute (never silently swallows)", async () => {
    const out = await noteTool.execute({ subject: "x", claim: "y" })
    expect(out).toMatch(/not bound/i)
  })
})

describe("bindNoteTool", () => {
  it("calls the handler with parsed payload and returns a stored result string", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, noteId: "abc-123" })
    const tool = bindNoteTool(handler)

    const out = await tool.execute({
      subject: "  publish.Revenue.RevenueZARMTD  ",
      claim: "cumulative MTD column",
      evidence: "profile_data showed monotone-increasing within client+period",
      category: "column_semantics"
    })

    expect(handler).toHaveBeenCalledWith({
      subject: "publish.Revenue.RevenueZARMTD",
      claim: "cumulative MTD column",
      evidence: "profile_data showed monotone-increasing within client+period",
      category: "column_semantics"
    })
    expect(out).toContain("stored")
    expect(out).toContain("abc-123")
    expect(out).toContain("column_semantics")
  })

  it("rejects empty subject or claim before invoking the handler", async () => {
    const handler = vi.fn()
    const tool = bindNoteTool(handler)

    const a = await tool.execute({ subject: "   ", claim: "ok" })
    expect(a).toMatch(/subject.*required/i)
    expect(handler).not.toHaveBeenCalled()

    const b = await tool.execute({ subject: "ok", claim: "" })
    expect(b).toMatch(/claim.*required/i)
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects unknown categories", async () => {
    const handler = vi.fn()
    const tool = bindNoteTool(handler)
    const out = await tool.execute({ subject: "s", claim: "c", category: "made-up" })
    expect(out).toMatch(/category.*must be one of/i)
    expect(handler).not.toHaveBeenCalled()
  })

  it("accepts every documented category", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, noteId: "x" })
    const tool = bindNoteTool(handler)
    for (const cat of NOTE_CATEGORIES) {
      const out = await tool.execute({ subject: "s", claim: "c", category: cat })
      expect(out).toContain("stored")
    }
    expect(handler).toHaveBeenCalledTimes(NOTE_CATEGORIES.length)
  })

  it("omits evidence and category when not supplied", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, noteId: "id1" })
    const tool = bindNoteTool(handler)
    await tool.execute({ subject: "s", claim: "c" })
    expect(handler).toHaveBeenCalledWith({
      subject: "s",
      claim: "c",
      evidence: undefined,
      category: undefined
    })
  })

  it("surfaces handler failures as a not-stored message", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: false, reason: "duplicate" })
    const tool = bindNoteTool(handler)
    const out = await tool.execute({ subject: "s", claim: "c" })
    expect(out).toMatch(/not stored/i)
    expect(out).toContain("duplicate")
  })
})
