import { describe, expect, it } from "vitest"

import { asFlowId, asStrategyId, asTenantId } from "../types/branded-ids.js"

import type { EntityDefinition } from "./types.js"
import {
  hasUnresolvedLegacyPipelineNote,
  isDegradedLegacyFallbackPredicate,
} from "./resolve-scope-predicate.js"
import { validateEntityDefinition } from "./validate.js"

function degradedContentEntity(): EntityDefinition {
  return {
    tenantId: asTenantId("_default"),
    id: "content",
    displayName: "Content",
    description: "test",
    rootTable: "gate.Content",
    idColumn: "contentId",
    labelColumn: "title",
    selfJoinColumn: "parentContentId",
    tables: [
      {
        name: "gate.ContentType",
        scope: {
          kind: "sql",
          predicate:
            "[contentTypeId] IN (SELECT DISTINCT [contentTypeId] FROM [gate].[Content] WHERE [contentId] IN ({ids}))",
        },
        executionOrder: 1,
        scd2Override: null,
        verified: true,
        archiveTable: null,
        note: "Predicate unresolved from legacy pipeline variable @contentTypeIds. Verify against core.uspSyncContentObjectsTran body.",
        provenance: { kind: "manual" },
        scopeColumn: "contentTypeId",
        source: "pipeline-only",
        groundedByPipeline: true,
        enabledByDefault: true,
        userControllable: false,
      },
    ],
    policies: { freezeWindowIds: [] },
    scd2: { strategyId: asStrategyId("mymi-scd2"), strategyVersion: "latest", entityOverride: null },
    lineageRefs: [],
    provenance: { kind: "legacy-migration", legacyPipelineId: 692 },
    flowId: asFlowId("content"),
    legacyEntrySproc: "core.uspSyncContentObjectsTran",
    reverseOrder: [],
    discrepancies: [],
    version: 1,
    versionLabel: null,
    createdBy: "test",
    reason: "test",
    createdAt: new Date().toISOString(),
    retiredAt: null,
  }
}

describe("degraded legacy predicate guards", () => {
  it("detects unresolved legacy pipeline notes", () => {
    expect(
      hasUnresolvedLegacyPipelineNote(
        "Predicate unresolved from legacy pipeline variable @contentTypeIds. Verify against core.uspSyncContentObjectsTran body.",
      ),
    ).toBe(true)
  })

  it("detects degraded IN-list fallback predicates", () => {
    expect(
      isDegradedLegacyFallbackPredicate(
        "[contentTypeId] IN (SELECT DISTINCT [contentTypeId] FROM [gate].[Content] WHERE [contentId] IN ({ids}))",
      ),
    ).toBe(true)
    expect(
      isDegradedLegacyFallbackPredicate(
        "EXISTS (SELECT 1 FROM gate.Content WHERE contentId = {id})",
      ),
    ).toBe(false)
  })

  it("rejects degraded IN-list fallback predicates even when unverified", () => {
    const entity = degradedContentEntity()
    entity.tables[0]!.verified = false
    entity.tables[0]!.enabledByDefault = false
    const result = validateEntityDefinition(entity)
    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.code === "scope_degraded_legacy")).toBe(true)
  })
})
