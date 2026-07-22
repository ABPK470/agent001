import { describe, expect, it } from "vitest"
import {
  buildBrowseDetailEntries,
  classifyBrowseValue,
  formatBrowseScalar,
  formatBrowseTimestamp,
  humanizeBrowseKey,
  isIsoLikeTimestamp,
} from "./admin-browse-detail"

describe("admin-browse-detail", () => {
  it("humanizes keys with overrides", () => {
    expect(humanizeBrowseKey("publishedAt")).toBe("Published")
    expect(humanizeBrowseKey("definitionCount")).toBe("Definitions")
    expect(humanizeBrowseKey("runId")).toBe("Run")
    expect(humanizeBrowseKey("someCustomField")).toBe("Some custom field")
  })

  it("detects and formats ISO timestamps", () => {
    expect(isIsoLikeTimestamp("2024-07-19T20:04:47.370Z")).toBe(true)
    expect(isIsoLikeTimestamp("not-a-date")).toBe(false)
    const formatted = formatBrowseTimestamp("2024-07-19T20:04:47.370Z")
    expect(formatted).not.toBe("2024-07-19T20:04:47.370Z")
    expect(formatted).not.toContain("T20:04:47")
    expect(formatted.length).toBeGreaterThan(8)
  })

  it("classifies values", () => {
    expect(classifyBrowseValue("publishedAt", "2024-07-19T20:04:47.370Z")).toBe("timestamp")
    expect(classifyBrowseValue("definitionCount", 6)).toBe("number")
    expect(classifyBrowseValue("runId", "abc-123")).toBe("id")
    expect(classifyBrowseValue("ok", true)).toBe("boolean")
  })

  it("formats scalars for display", () => {
    expect(formatBrowseScalar("definitionCount", 6)).toBe("6")
    expect(formatBrowseScalar("ok", false)).toBe("No")
    expect(formatBrowseScalar("name", "")).toBe("—")
  })

  it("orders known keys and skips empties", () => {
    const entries = buildBrowseDetailEntries(
      { definitionCount: 6, publishedAt: "2024-07-19T20:04:47.370Z" },
      { runId: "r1", threadId: "" },
    )
    expect(entries.map((e) => e.key)).toEqual(["runId", "publishedAt", "definitionCount"])
    expect(entries[0]?.label).toBe("Run")
  })
})
