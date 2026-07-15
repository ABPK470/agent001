import { describe, expect, it } from "vitest"
import {
  classifySchemaRole,
  isAnalyticEntityCandidate,
  rowCountBonusForSchema
} from "../src/tools/catalog/schema-role.js"

describe("schema-role", () => {
  it("classifies DWH archive separately from ops archive schemas", () => {
    expect(classifySchemaRole("archive")).toBe("dwh-archive")
    expect(classifySchemaRole("coreArchive")).toBe("ops-archive")
    expect(classifySchemaRole("dim")).toBe("analytic")
  })

  it("suppresses row-count bonus for archive schemas", () => {
    expect(rowCountBonusForSchema("archive", 50_000_000)).toBe(0)
    expect(rowCountBonusForSchema("dim", 50_000_000)).toBeGreaterThan(0)
  })

  it("excludes archive tables from analytic entity candidates unless goal mentions archive", () => {
    expect(isAnalyticEntityCandidate("archive.ClientSnapshot")).toBe(false)
    expect(
      isAnalyticEntityCandidate("archive.ClientSnapshot", { goalMentionsArchive: true })
    ).toBe(true)
    expect(isAnalyticEntityCandidate("dim.Client")).toBe(true)
  })
})
