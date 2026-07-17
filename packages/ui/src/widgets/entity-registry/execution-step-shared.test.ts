import { describe, expect, it } from "vitest"
import type { SyncFlowKindDefinition } from "../../types"

import {
  deriveStepIdentityFromAction,
  deriveStepKeyForKind,
  flowStepHeaderLines,
  kindDisplayLabel,
  stepSettingsSummary,
} from "./execution-step-shared"

describe("execution-step-shared", () => {
  it("derives step key from action type", () => {
    expect(deriveStepKeyForKind("metadataSync", [])).toBe("metadataSync")
  })

  it("suffixes duplicate step keys in the same flow", () => {
    expect(
      deriveStepKeyForKind("metadataSync", [{ id: "metadataSync" }], 1),
    ).toBe("metadataSync-2")
  })

  it("derives id and title from action catalog entry", () => {
    const catalog = new Map([
      [
        "metadataSync",
        {
          summary: "Metadata sync",
          description: "",
          handler: { type: "metadata_sync" as const, connection: "target" as const },
          stepFields: {},
          failureMode: "fatal" as const,
          entityTypes: ["any" as const],
        },
      ],
    ])

    expect(
      deriveStepIdentityFromAction("metadataSync", catalog, undefined, []),
    ).toEqual({
      kind: "metadataSync",
      id: "metadataSync",
      title: "Metadata sync",
    })
    expect(kindDisplayLabel("metadataSync", catalog)).toBe("Metadata sync")
  })

  it("includes handler type in flow step header lines", () => {
    const catalog = new Map<string, SyncFlowKindDefinition>([
      [
        "pipelineStart",
        {
          summary: "Start pipeline run",
          description: "",
          handler: {
            type: "http_request" as const,
            connection: "target" as const,
            httpMethod: "POST" as const,
            httpPath: "http://example",
            httpBody: [{ name: "name", source: { type: "catalog", id: "pipelineName" } }],
          },
          stepFields: {},
          failureMode: "fatal" as const,
          entityTypes: ["any" as const],
        },
      ],
    ])

    expect(
      flowStepHeaderLines(
        { id: "http-pipe-test", kind: "pipelineStart", title: "Step 1", description: "", bindings: {} },
        catalog,
      ),
    ).toMatchObject({
      primary: "Step 1",
      secondary: "Start pipeline run · http-pipe-test",
      handlerType: "http_request",
    })
  })

  it("summarizes step parameters with field labels", () => {
    const catalog = new Map<string, SyncFlowKindDefinition>([
      [
        "pipelineStart",
        {
          summary: "Start pipeline run",
          description: "",
          handler: {
            type: "http_request" as const,
            connection: "target" as const,
            httpMethod: "POST" as const,
            httpPath: "http://example",
            httpBody: [{ name: "name", source: { type: "catalog", id: "pipelineName" } }],
          },
          stepFields: {},
          failureMode: "fatal" as const,
          entityTypes: ["any" as const],
        },
      ],
    ])

    expect(
      stepSettingsSummary(
        {
          id: "http-pipe-test",
          kind: "pipelineStart",
          title: "Step 1",
          description: "",
          bindings: {},
          pipelineName: "test",
        },
        catalog,
        {
          pipelineName: {
            label: "Pipeline name",
            definition: { description: "Pipeline name", resolver: { kind: "stepField", field: "pipelineName" } },
          },
        },
      ),
    ).toBe("Text: Pipeline name: test")
  })
})
