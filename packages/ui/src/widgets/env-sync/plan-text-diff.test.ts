import { describe, expect, it } from "vitest"

import { buildInlineTextDiff } from "./plan-text-diff"

function segmentText(segments: { kind: string; text: string }[]): string {
  return segments.map((segment) => segment.text).join("")
}

describe("plan-text-diff", () => {
  it("returns same segments when texts are identical", () => {
    const diff = buildInlineTextDiff("hello world", "hello world")
    expect(diff.old).toEqual([{ kind: "same", text: "hello world" }])
    expect(diff.new).toEqual([{ kind: "same", text: "hello world" }])
  })

  it("highlights changed words on old and new sides", () => {
    const diff = buildInlineTextDiff(
      "Africa Flex daily balances v1",
      "Africa Flex daily balances v2",
    )
    expect(segmentText(diff.old)).toBe("Africa Flex daily balances v1")
    expect(segmentText(diff.new)).toBe("Africa Flex daily balances v2")
    expect(diff.old.some((segment) => segment.kind === "removed" && segment.text.includes("v1"))).toBe(true)
    expect(diff.new.some((segment) => segment.kind === "added" && segment.text.includes("v2"))).toBe(true)
    expect(diff.old.some((segment) => segment.kind === "same" && segment.text.includes("Africa Flex"))).toBe(true)
  })

  it("highlights changed JSON field values", () => {
    const oldJson = '{\n  "deployDate": "2026-06-10T21:02:33.077Z",\n  "contractId": 4995\n}'
    const newJson = '{\n  "deployDate": "2024-10-14T20:31:58.233Z",\n  "contractId": 4995\n}'
    const diff = buildInlineTextDiff(oldJson, newJson)
    expect(segmentText(diff.old)).toBe(oldJson)
    expect(segmentText(diff.new)).toBe(newJson)
    expect(diff.old.some((segment) => segment.kind === "removed" && segment.text.includes("2026-06-10"))).toBe(true)
    expect(diff.new.some((segment) => segment.kind === "added" && segment.text.includes("2024-10-14"))).toBe(true)
    expect(diff.old.some((segment) => segment.kind === "same" && segment.text.includes("contractId"))).toBe(true)
  })

  it("marks fully replaced text as removed vs added", () => {
    const diff = buildInlineTextDiff("old-only", "new-only")
    expect(diff.old).toEqual([{ kind: "removed", text: "old-only" }])
    expect(diff.new).toEqual([{ kind: "added", text: "new-only" }])
  })
})
