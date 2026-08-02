import { describe, expect, it } from "vitest"
import {
  isValidJsonText,
  statusMarkerClass,
  validateToolArguments,
} from "./trace-tool-schema"

const tools = [
  {
    name: "search",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
    },
  },
]

describe("validateToolArguments", () => {
  it("marks missing required fields", () => {
    const result = validateToolArguments(tools, "search", {})
    expect(result.missingRequired).toEqual(["query"])
    expect(result.markers.some((m) => m.path === "query" && m.status === "missing")).toBe(true)
  })

  it("marks unknown fields", () => {
    const result = validateToolArguments(tools, "search", {
      query: "x",
      extra: true,
    })
    expect(result.unknownFields).toEqual(["extra"])
  })

  it("marks valid arguments", () => {
    const result = validateToolArguments(tools, "search", { query: "hello", limit: 5 })
    expect(result.missingRequired).toEqual([])
    expect(result.unknownFields).toEqual([])
    expect(result.markers.every((m) => m.status === "valid")).toBe(true)
  })
})

describe("isValidJsonText", () => {
  it("detects JSON objects", () => {
    expect(isValidJsonText('{"a":1}')).toBe(true)
    expect(isValidJsonText("plain text")).toBe(false)
  })
})

describe("statusMarkerClass", () => {
  it("maps statuses to css classes", () => {
    expect(statusMarkerClass("valid")).toContain("is-valid")
    expect(statusMarkerClass("missing")).toContain("is-missing")
  })
})
