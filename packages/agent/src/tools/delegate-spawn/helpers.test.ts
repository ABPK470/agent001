import { describe, expect, it } from "vitest"
import { buildChildExecutionResult } from "./helpers.js"

describe("buildChildExecutionResult", () => {
  it("keeps a lasting search_catalog parameter error as a blocker", () => {
    const result = buildChildExecutionResult("done", [
      {
        name: "search_catalog",
        args: {},
        result: "Error: Provide at least one mode parameter: search, table, …",
        isError: false,
      },
    ])
    expect(result.status).toBe("failed")
    expect(result.unresolvedBlockers[0]).toMatch(/search_catalog/)
  })

  it("drops a search_catalog error when a later call to the same tool succeeds", () => {
    const result = buildChildExecutionResult("found Revenue", [
      {
        name: "search_catalog",
        args: { connection: "prod" },
        result: "Error: Provide at least one mode parameter: search, table, …",
        isError: false,
      },
      {
        name: "search_catalog",
        args: { search: "Revenue" },
        result: "Found publish.Revenue",
        isError: false,
      },
    ])
    expect(result.status).toBe("success")
    expect(result.unresolvedBlockers).toEqual([])
  })

  it("still clears write errors when a later write hits the same path", () => {
    const result = buildChildExecutionResult("ok", [
      {
        name: "write_file",
        args: { path: "tmp/out.md", content: "x" },
        result: "Error: disk full",
        isError: true,
      },
      {
        name: "write_file",
        args: { path: "tmp/out.md", content: "y" },
        result: "Wrote tmp/out.md",
        isError: false,
      },
    ])
    expect(result.status).toBe("success")
    expect(result.unresolvedBlockers).toEqual([])
    expect(result.producedArtifacts).toEqual(["tmp/out.md"])
  })
})
