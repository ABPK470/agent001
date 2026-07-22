import { describe, expect, it } from "vitest"

import {
  collectCatalogIdsFromValueSource,
  formatValueSourcePreview,
  isValueSource,
  validateValueSource,
} from "./value-source.js"

describe("ValueSource", () => {
  it("recognizes catalog, literal, and priorOutput variants", () => {
    expect(isValueSource({ type: "priorOutput", stepId: "metadataSync", output: "datasetId" })).toBe(true)
    expect(isValueSource({ type: "literal", value: 42 })).toBe(true)
    expect(isValueSource({ type: "catalog", id: "planEntityId" })).toBe(true)
    expect(isValueSource({ type: "planEntityId" })).toBe(false)
    expect(isValueSource({ type: "stepField", field: "objectName" })).toBe(false)
  })

  it("rejects legacy string grammars", () => {
    expect(isValueSource("entity-id")).toBe(false)
    expect(isValueSource({ type: "catalog", id: "bad id" })).toBe(true)
  })

  it("validates priorOutput and catalog ids", () => {
    expect(validateValueSource({ type: "priorOutput", stepId: "", output: "x" })).toMatch(/stepId/)
    expect(validateValueSource({ type: "catalog", id: "bad id" })).toMatch(/camelCase/)
    expect(validateValueSource({ type: "catalog", id: "planEntityId" })).toBeNull()
  })

  it("collects catalog ids from catalog refs", () => {
    expect(collectCatalogIdsFromValueSource({ type: "catalog", id: "planEntityId" })).toEqual(["planEntityId"])
    expect(collectCatalogIdsFromValueSource({ type: "catalog", id: "objectName" })).toEqual(["objectName"])
  })

  it("formats preview labels from catalog identity (name + key), not resolution Auto: tags", () => {
    expect(formatValueSourcePreview({ type: "catalog", id: "planEntityId" })).toBe("planEntityId")
    expect(
      formatValueSourcePreview(
        { type: "catalog", id: "planEntityId" },
        {
          customCatalog: {
            planEntityId: { description: "Entity id", resolver: { kind: "planEntityId" } },
          },
          customLabels: { planEntityId: "Plan entity id" },
        },
      ),
    ).toBe("Plan entity id")
    expect(
      formatValueSourcePreview(
        { type: "catalog", id: "opsActorUpn" },
        {
          customCatalog: {
            opsActorUpn: { description: "Ops UPN", resolver: { kind: "planActor" } },
          },
          customLabels: { opsActorUpn: "Ops plan actor" },
        },
      ),
    ).toBe("Ops plan actor")
    expect(
      formatValueSourcePreview({
        type: "priorOutput",
        stepId: "metadataSync",
        output: "datasetId",
      }),
    ).toContain("metadataSync")
  })
})
