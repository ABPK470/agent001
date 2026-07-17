import { describe, expect, it } from "vitest"

import {
  StepOutputRegistry,
  firstSqlResultRow,
  flatJsonObject,
  mergeHandlerResultOutputs,
  mergeProcedureResultOutputs,
  mergeShellCommandOutputs,
  parseFlatJsonText,
} from "./step-output-registry.js"

describe("StepOutputRegistry", () => {
  it("publishes and reads outputs by step id and key", () => {
    const registry = new StepOutputRegistry()
    registry.publish("create-stage", { datasetId: 99, id: 788 })
    expect(registry.get("create-stage", "datasetId")).toBe(99)
  })

  it("throws when step or key is missing", () => {
    const registry = new StepOutputRegistry()
    registry.publish("a", { x: 1 })
    expect(() => registry.get("missing", "x")).toThrow(/has not run/)
    expect(() => registry.get("a", "y")).toThrow(/no output "y"/)
  })
})

describe("mergeHandlerResultOutputs", () => {
  it("merges first sproc result row without overwriting inputs", () => {
    expect(
      mergeProcedureResultOutputs(
        { id: 1, action: "Run" },
        { recordsets: [[{ datasetId: 42, status: "ok" }]] },
      ),
    ).toEqual({ id: 1, action: "Run", datasetId: 42, status: "ok" })
  })

  it("merges first query recordset row", () => {
    expect(
      mergeHandlerResultOutputs({ id: 1 }, { recordset: [{ sum: 99 }] }),
    ).toEqual({ id: 1, sum: 99 })
  })

  it("merges flat JSON response fields", () => {
    expect(
      mergeHandlerResultOutputs({ ruleId: 791 }, { jobId: "abc", status: "queued" }),
    ).toEqual({ ruleId: 791, jobId: "abc", status: "queued" })
  })

  it("merges flat JSON from shell stdout", () => {
    expect(mergeShellCommandOutputs({ id: 42 }, '{"doubled":84}')).toEqual({
      id: 42,
      doubled: 84,
    })
  })

  it("falls back to stdout text when shell output is not JSON", () => {
    expect(mergeShellCommandOutputs({ id: 42 }, "done")).toEqual({ id: 42, stdout: "done" })
  })
})

describe("parseFlatJsonText", () => {
  it("parses flat JSON objects and skips nested values", () => {
    expect(parseFlatJsonText('{"jobId":"abc","meta":{"x":1}}')).toEqual({ jobId: "abc" })
  })

  it("returns null for non-json text", () => {
    expect(parseFlatJsonText("plain text")).toBeNull()
  })
})

describe("firstSqlResultRow", () => {
  it("reads recordset or recordsets", () => {
    expect(firstSqlResultRow({ recordset: [{ a: 1 }] })).toEqual({ a: 1 })
    expect(firstSqlResultRow({ recordsets: [[{ b: 2 }]] })).toEqual({ b: 2 })
  })
})

describe("flatJsonObject", () => {
  it("accepts only flat primitive entries", () => {
    expect(flatJsonObject({ ok: true, count: 3, label: "x" })).toEqual({
      ok: true,
      count: 3,
      label: "x",
    })
  })
})
