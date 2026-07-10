import { describe, expect, it } from "vitest"

import {
  collectCatalogIdsFromValueSource,
  formatValueSourcePreview,
  isValueSource,
  validateValueSource,
} from "./value-source.js"

describe("ValueSource", () => {
  it("recognizes builtin and structured variants", () => {
    expect(isValueSource({ type: "planEntityId" })).toBe(true)
    expect(isValueSource({ type: "stepField", field: "objectName" })).toBe(true)
    expect(isValueSource({ type: "priorOutput", stepId: "metadataSync", output: "datasetId" })).toBe(true)
    expect(isValueSource({ type: "literal", value: 42 })).toBe(true)
    expect(isValueSource({ type: "catalog", id: "myLookup" })).toBe(true)
  })

  it("rejects legacy string grammars", () => {
    expect(isValueSource("entity-id")).toBe(false)
    expect(isValueSource({ type: "stepField", field: "object-name" })).toBe(false)
  })

  it("validates priorOutput and catalog ids", () => {
    expect(validateValueSource({ type: "priorOutput", stepId: "", output: "x" })).toMatch(/stepId/)
    expect(validateValueSource({ type: "catalog", id: "bad id" })).toMatch(/camelCase/)
    expect(validateValueSource({ type: "planEntityId" })).toBeNull()
  })

  it("collects catalog ids from catalog refs and legacy shorthand", () => {
    expect(collectCatalogIdsFromValueSource({ type: "planEntityId" })).toEqual(["planEntityId"])
    expect(collectCatalogIdsFromValueSource({ type: "catalog", id: "myLookup" })).toEqual(["myLookup"])
    expect(collectCatalogIdsFromValueSource({ type: "stepField", field: "objectName" })).toEqual(["objectName"])
  })

  it("formats preview labels", () => {
    expect(formatValueSourcePreview({ type: "planEntityId" })).toContain("Plan entity id")
    expect(formatValueSourcePreview({ type: "stepField", field: "pipelineName" })).toContain("Pipeline name")
    expect(
      formatValueSourcePreview({
        type: "priorOutput",
        stepId: "metadataSync",
        output: "datasetId",
      }),
    ).toContain("metadataSync")
  })
})
