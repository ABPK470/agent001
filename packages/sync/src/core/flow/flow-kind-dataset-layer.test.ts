import { describe, expect, it } from "vitest"

import { createsDatasetLayer } from "./flow-kind-dataset-layer.js"

describe("createsDatasetLayer", () => {
  it("infers from uspCreateDataset procedure name", () => {
    expect(
      createsDatasetLayer({
        handler: {
          type: "mssql_procedure",
          connection: "target",
          procedure: "core.uspCreateDataset",
          parameters: [],
        },
      }),
    ).toBe(true)
  })

  it("does not infer for FK procedure", () => {
    expect(
      createsDatasetLayer({
        handler: {
          type: "mssql_procedure",
          connection: "target",
          procedure: "core.uspCreateDatasetFKs",
          parameters: [],
        },
      }),
    ).toBe(false)
  })

  it("respects explicit flag", () => {
    expect(
      createsDatasetLayer({
        createsDatasetLayer: true,
        handler: {
          type: "http_request",
          connection: "target",
          httpMethod: "POST",
          httpService: "etl",
          httpPath: "/x",
        },
      }),
    ).toBe(true)
  })
})
