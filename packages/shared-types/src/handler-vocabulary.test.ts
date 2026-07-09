import { describe, expect, it } from "vitest"

import { idToCatalogDescription, idToCatalogLabel } from "./catalog-id.js"

describe("handler vocabulary helpers", () => {
  it("derives label from camelCase id", () => {
    expect(idToCatalogLabel("testStepType")).toBe("Test Step Type")
    expect(idToCatalogLabel("my_custom_step")).toBe("My Custom Step")
  })

  it("derives description from id", () => {
    expect(idToCatalogDescription("testStepType", "stepType")).toBe("Test Step Type kind.")
  })
})
