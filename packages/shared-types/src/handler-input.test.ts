import { describe, expect, it } from "vitest"

import {
  DEFAULT_CUSTOM_HANDLER_INPUTS,
  handlerInputSlots,
  substituteInputTokens,
} from "./handler-input.js"

describe("handler-input", () => {
  it("uses default procedure input when parameters omitted", () => {
    expect(
      handlerInputSlots({
        type: "mssql_procedure",
        connection: "target",
        procedure: "core.uspX",
      }),
    ).toEqual([{ name: "id", source: { type: "catalog", id: "planEntityId" } }])
  })

  it("accepts stored procedures with no parameters", () => {
    expect(
      handlerInputSlots({
        type: "mssql_procedure",
        connection: "target",
        procedure: "core.uspX",
        parameters: [],
      }),
    ).toEqual([])
  })

  it("uses default custom handler inputs when none configured", () => {
    expect(
      handlerInputSlots({
        type: "custom_sql",
        connection: "target",
        sqlBatch: "SELECT 1",
      }),
    ).toEqual([...DEFAULT_CUSTOM_HANDLER_INPUTS])
  })

  it("substitutes template tokens strictly", () => {
    expect(() => substituteInputTokens("echo @missing", { id: 1 })).toThrow(/no input slot named "missing"/)
  })
})
