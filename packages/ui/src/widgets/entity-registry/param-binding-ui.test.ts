import { describe, expect, it } from "vitest"

import {
  applyHandlerParamBindingMode,
  inferHandlerParamBindingMode,
  mergeHandlerParamPatch,
} from "./param-binding-ui"

describe("param-binding-ui", () => {
  it("switches fixed resolver to choose on each flow step", () => {
    const param = { name: "id", source: { type: "planEntityId" as const } }
    const next = applyHandlerParamBindingMode(param, "set-on-flow-step", {
      resolverOptions: [{ value: "planEntityId" }],
      textFieldOptions: [{ value: "catalog:auditObjectType" }],
      flowStepOptions: [],
    })
    expect(next).toEqual({ name: "id" })
    expect(inferHandlerParamBindingMode(next)).toBe("set-on-flow-step")
  })

  it("switches fixed resolver to operator text field", () => {
    const param = { name: "id", source: { type: "planEntityId" as const } }
    const next = applyHandlerParamBindingMode(param, "text-field", {
      resolverOptions: [{ value: "planEntityId" }],
      textFieldOptions: [{ value: "catalog:auditObjectType" }],
      flowStepOptions: [],
    })
    expect(next.source).toEqual({ type: "catalog", id: "auditObjectType" })
    expect(inferHandlerParamBindingMode(next)).toBe("text-field")
  })

  it("switches operator text field to earlier step without throwing", () => {
    const param = { name: "id", source: { type: "stepField" as const, field: "auditObjectType" as const } }
    const next = applyHandlerParamBindingMode(param, "earlier-step", {
      resolverOptions: [{ value: "planEntityId" }],
      textFieldOptions: [{ value: "catalog:auditObjectType" }],
      flowStepOptions: [{ value: "metadataSync", label: "metadataSync" }],
    })
    expect(next.source).toEqual({ type: "priorOutput", stepId: "metadataSync", output: "" })
    expect(inferHandlerParamBindingMode(next)).toBe("earlier-step")
  })

  it("drops stale source when patching with undefined", () => {
    const row = { name: "id", source: { type: "planEntityId" as const } }
    const next = mergeHandlerParamPatch(row, { source: undefined })
    expect(next).toEqual({ name: "id" })
  })
})
