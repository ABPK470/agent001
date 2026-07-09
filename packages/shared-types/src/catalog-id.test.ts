import { describe, expect, it } from "vitest"

import { isCatalogId, METADATA_SYNC_KIND_ID, validateCatalogId } from "./catalog-id.js"

describe("catalog-id", () => {
  it("accepts camelCase ids", () => {
    expect(isCatalogId("metadataSync")).toBe(true)
    expect(isCatalogId("auditObjectType")).toBe(true)
    expect(isCatalogId("preTransaction")).toBe(true)
  })

  it("rejects kebab-case and invalid ids", () => {
    expect(isCatalogId("metadata-sync")).toBe(false)
    expect(isCatalogId("audit-object-type")).toBe(false)
    expect(isCatalogId("AuditCheck")).toBe(false)
    expect(isCatalogId("")).toBe(false)
  })

  it("exposes metadata sync kind id", () => {
    expect(METADATA_SYNC_KIND_ID).toBe("metadataSync")
  })

  it("validateCatalogId returns message for invalid ids", () => {
    expect(validateCatalogId("metadata-sync", "Kind id")).toMatch(/camelCase/)
    expect(validateCatalogId("auditCheck", "Kind id")).toBeNull()
  })
})
