import { describe, expect, it } from "vitest"

import { PostMetadataActionKind } from "./enums.js"
import { resolvePostMetadataActions } from "./recipes.js"

describe("resolvePostMetadataActions", () => {
  it("maps dataset to dataset deploy", () => {
    expect(resolvePostMetadataActions({ entityType: "dataset", legacyPipelineId: 792 })).toEqual([
      { kind: PostMetadataActionKind.DatasetDeploy },
    ])
  })

  it("maps rule to dataset deploy, rules deploy, then dependency handling", () => {
    expect(resolvePostMetadataActions({ entityType: "rule", legacyPipelineId: 791 })).toEqual([
      { kind: PostMetadataActionKind.DatasetDeploy },
      { kind: PostMetadataActionKind.RulesDeploy },
      { kind: PostMetadataActionKind.HandleDependencies },
    ])
  })

  it("maps gate metadata to refresh then pipeline start", () => {
    expect(resolvePostMetadataActions({ entityType: "gateMetadata", legacyPipelineId: 780 })).toEqual([
      { kind: PostMetadataActionKind.MetaRefresh },
      { kind: PostMetadataActionKind.PipelineStart },
    ])
  })

  it("maps pipeline activity to pipeline register", () => {
    expect(resolvePostMetadataActions({ entityType: "pipelineActivity", legacyPipelineId: 798 })).toEqual([
      { kind: PostMetadataActionKind.PipelineRegister },
    ])
  })

  it("maps content to dependency handling", () => {
    expect(resolvePostMetadataActions({ entityType: "content", legacyPipelineId: 692 })).toEqual([
      { kind: PostMetadataActionKind.HandleDependencies },
    ])
  })

  it("preserves explicit recipe actions when provided", () => {
    expect(resolvePostMetadataActions({
      entityType: "dataset",
      legacyPipelineId: 792,
      postMetadataActions: [{ kind: PostMetadataActionKind.PipelineRegister }],
    })).toEqual([
      { kind: PostMetadataActionKind.PipelineRegister },
    ])
  })
})