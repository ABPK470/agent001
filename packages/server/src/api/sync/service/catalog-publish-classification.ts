import { parseBoundaryJson } from "../../../internal/parse-json.js"

/**
 * Classify tip vs published catalog for Publish / preview gates.
 *
 * Ongoing SoT: diffs the active tip snapshot against the catalog version stamped
 * at last Publish, then splits compile-relevant vs operational sections.
 *
 * Preview/execute run **published** SyncDefinitions (frozen entity + flow catalog).
 * Environments / connectors stay live and must NOT arm Publish or dirty every entity.
 */

import type { PublishedSyncDefinition } from "@mia/shared-types"

import {
  diffDeployCatalogSnapshots,
  type CatalogDiffSectionId,
  type DeployCatalogSnapshotDiff,
} from "../../platform/service/diff-deploy-catalog-snapshots.js"
import {
  buildDeployCatalogSnapshot,
  type DeployCatalogSnapshot,
} from "../../platform/service/export-deploy-artifacts.js"
import * as db from "../../../infra/persistence/sqlite.js"

const DEFAULT_TENANT_ID = "_default"

export type PersistedPublishedBundle = {
  version: 1
  publishedAt: string
  publishedVersion: string
  catalogVersion?: number | null
  definitions: Record<string, PublishedSyncDefinition | null>
}

function loadPublishedBundle(tenantId: string): PersistedPublishedBundle | null {
  const raw = db.loadPublishedBundleFromDb(tenantId)
  if (!raw) return null
  return {
    version: 1,
    publishedAt: raw.publishedAt,
    publishedVersion: raw.publishedVersion,
    catalogVersion: raw.catalogVersion,
    definitions: raw.definitions as Record<string, PublishedSyncDefinition | null>,
  }
}

/** Tip sections that change the published SyncDefinition contract. */
export const COMPILE_CATALOG_SECTIONS: ReadonlySet<CatalogDiffSectionId> = new Set([
  "entities",
  "configs",
  "strategies",
  "flows",
  "actions",
  "valueSources",
  "phases",
])

/** Tip sections that are live at preview/execute — tip history only. */
export const OPERATIONAL_CATALOG_SECTIONS: ReadonlySet<CatalogDiffSectionId> = new Set([
  "environments",
])

export type CatalogPublishClassification = {
  activeCatalogVersion: number | null
  publishedCatalogVersion: number | null
  publishedAt: string | null
  /** Tip version ≠ published stamp (any section, including environments). */
  tipAhead: boolean
  /** Compile-relevant tip delta — arms Publish. */
  compileNeedsPublish: boolean
  /** Tip ahead solely due to operational sections (e.g. environments). */
  operationalOnlyAhead: boolean
  dirtyCompileSections: CatalogDiffSectionId[]
  dirtyOperationalSections: CatalogDiffSectionId[]
  /** Entity ids whose published contract is stale vs tip (compile affect). */
  compileAffectedEntityIds: string[]
  published: PersistedPublishedBundle | null
  tipSnapshot: DeployCatalogSnapshot
  publishedSnapshot: DeployCatalogSnapshot | null
  diff: DeployCatalogSnapshotDiff | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function loadSnapshotAtVersion(
  tenantId: string,
  version: number | null,
): DeployCatalogSnapshot | null {
  if (version == null) return null
  const row = db.getSyncCatalogVersionRow(tenantId, version)
  if (!row) return null
  try {
    return parseBoundaryJson(row.snapshot_json) as DeployCatalogSnapshot
  } catch {
    return null
  }
}

function sectionEntryIds(diff: DeployCatalogSnapshotDiff, section: CatalogDiffSectionId): string[] {
  const hit = diff.sections.find((s) => s.section === section)
  if (!hit) return []
  return [...hit.creates, ...hit.updates, ...hit.deletes].map((e) => e.id)
}

function flowStepsFromTip(snapshot: DeployCatalogSnapshot, flowId: string): Array<{ kind?: string; phase?: string }> {
  const syncMetadata = asRecord(snapshot.syncMetadata) ?? {}
  const flowSource = asRecord(syncMetadata.flows) ?? {}
  const flow = asRecord(flowSource[flowId])
  if (!flow) return []
  const steps = flow.steps
  return Array.isArray(steps) ? (steps as Array<{ kind?: string; phase?: string }>) : []
}

function entityFlowId(entity: Record<string, unknown>): string | null {
  if (typeof entity.flowId === "string" && entity.flowId.trim() !== "") return entity.flowId
  const run = asRecord(entity.run)
  if (typeof run?.template === "string" && run.template.trim() !== "") return run.template
  return null
}

function entityStrategyId(entity: Record<string, unknown>): string | null {
  const scd2 = asRecord(entity.scd2)
  return typeof scd2?.strategyId === "string" ? scd2.strategyId : null
}

function valueSourceIdsFromPublished(def: PublishedSyncDefinition | null): Set<string> {
  const out = new Set<string>()
  const sources = def?.executionFlow?.catalog?.customValueSources
  if (!sources) return out
  for (const id of Object.keys(sources)) out.add(id)
  return out
}

function kindAndPhaseIdsFromPublished(def: PublishedSyncDefinition | null): {
  kinds: Set<string>
  phases: Set<string>
} {
  const kinds = new Set<string>()
  const phases = new Set<string>()
  for (const step of def?.executionFlow?.steps ?? []) {
    if (step.kind) kinds.add(step.kind)
    if (step.phase) phases.add(step.phase)
  }
  const snapKinds = def?.executionFlow?.catalog?.kinds
  if (snapKinds) {
    for (const id of Object.keys(snapKinds)) kinds.add(id)
  }
  const snapPhases = def?.executionFlow?.catalog?.phases
  if (snapPhases) {
    for (const id of Object.keys(snapPhases)) phases.add(id)
  }
  return { kinds, phases }
}

/**
 * Entities whose published SyncDefinition would change if tip were published now.
 * Environment-only tip deltas never contribute.
 */
export function compileAffectedEntityIdsFromDiff(args: {
  tip: DeployCatalogSnapshot
  published: PersistedPublishedBundle | null
  diff: DeployCatalogSnapshotDiff | null
}): string[] {
  const entities = (args.tip.entityRegistry?.entities ?? [])
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row != null && typeof row.id === "string")

  if (!args.published) {
    return entities.map((e) => String(e.id))
  }

  const affected = new Set<string>()
  const publishedDefs = args.published.definitions

  // Entity tip version vs published provenance (always).
  for (const entity of entities) {
    const id = String(entity.id)
    const publishedDef = publishedDefs[id] ?? null
    const tipVersion = typeof entity.version === "number" ? String(entity.version) : null
    const publishedSource = publishedDef?.provenance?.sourceVersion ?? null
    if (publishedDef == null || (tipVersion != null && tipVersion !== publishedSource)) {
      affected.add(id)
    }
  }

  if (!args.diff) return [...affected]

  const dirtyEntities = new Set(sectionEntryIds(args.diff, "entities"))
  const dirtyConfigs = new Set(sectionEntryIds(args.diff, "configs"))
  const dirtyStrategies = new Set(sectionEntryIds(args.diff, "strategies"))
  const dirtyFlows = new Set(sectionEntryIds(args.diff, "flows"))
  const dirtyActions = new Set(sectionEntryIds(args.diff, "actions"))
  const dirtyValueSources = new Set(sectionEntryIds(args.diff, "valueSources"))
  const dirtyPhases = new Set(sectionEntryIds(args.diff, "phases"))

  for (const entity of entities) {
    const id = String(entity.id)
    if (dirtyEntities.has(id) || dirtyConfigs.has(id)) {
      affected.add(id)
      continue
    }

    const strategyId = entityStrategyId(entity)
    if (strategyId && dirtyStrategies.has(strategyId)) {
      affected.add(id)
      continue
    }

    const flowId = entityFlowId(entity)
    if (flowId && dirtyFlows.has(flowId)) {
      affected.add(id)
      continue
    }

    const tipSteps = flowId ? flowStepsFromTip(args.tip, flowId) : []
    const publishedDef = publishedDefs[id] ?? null
    const publishedRefs = kindAndPhaseIdsFromPublished(publishedDef)
    const publishedValueSources = valueSourceIdsFromPublished(publishedDef)

    for (const step of tipSteps) {
      if (step.kind && dirtyActions.has(step.kind)) {
        affected.add(id)
        break
      }
      if (step.phase && dirtyPhases.has(step.phase)) {
        affected.add(id)
        break
      }
    }
    if (affected.has(id)) continue

    for (const kind of publishedRefs.kinds) {
      if (dirtyActions.has(kind)) {
        affected.add(id)
        break
      }
    }
    if (affected.has(id)) continue

    for (const phase of publishedRefs.phases) {
      if (dirtyPhases.has(phase)) {
        affected.add(id)
        break
      }
    }
    if (affected.has(id)) continue

    for (const vs of publishedValueSources) {
      if (dirtyValueSources.has(vs)) {
        affected.add(id)
        break
      }
    }
  }

  return [...affected]
}

export function classifyCatalogPublish(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): CatalogPublishClassification {
  void projectRoot
  const published = loadPublishedBundle(tenantId)
  const activeCatalogVersion = db.getActiveSyncCatalogVersion(tenantId)
  const publishedCatalogVersion = published?.catalogVersion ?? null
  const publishedAt = published?.publishedAt ?? null
  const tipSnapshot = buildDeployCatalogSnapshot({ tenantId })
  const tipAhead =
    published == null ||
    publishedCatalogVersion == null ||
    (activeCatalogVersion != null && activeCatalogVersion !== publishedCatalogVersion)

  if (!tipAhead) {
    // Still surface entity tip vs published provenance when catalog stamps match.
    const compileAffectedEntityIds = compileAffectedEntityIdsFromDiff({
      tip: tipSnapshot,
      published,
      diff: null,
    })
    return {
      activeCatalogVersion,
      publishedCatalogVersion,
      publishedAt,
      tipAhead: false,
      compileNeedsPublish: compileAffectedEntityIds.length > 0,
      operationalOnlyAhead: false,
      dirtyCompileSections: [],
      dirtyOperationalSections: [],
      compileAffectedEntityIds,
      published,
      tipSnapshot,
      publishedSnapshot: null,
      diff: null,
    }
  }

  if (published == null || publishedCatalogVersion == null) {
    const compileAffectedEntityIds = compileAffectedEntityIdsFromDiff({
      tip: tipSnapshot,
      published,
      diff: null,
    })
    return {
      activeCatalogVersion,
      publishedCatalogVersion,
      publishedAt,
      tipAhead: true,
      compileNeedsPublish: true,
      operationalOnlyAhead: false,
      dirtyCompileSections: [...COMPILE_CATALOG_SECTIONS],
      dirtyOperationalSections: [],
      compileAffectedEntityIds,
      published,
      tipSnapshot,
      publishedSnapshot: null,
      diff: null,
    }
  }

  const publishedSnapshot = loadSnapshotAtVersion(tenantId, publishedCatalogVersion)
  const diff = publishedSnapshot
    ? diffDeployCatalogSnapshots({
        from: publishedSnapshot,
        to: tipSnapshot,
        fromVersion: publishedCatalogVersion,
        toVersion: activeCatalogVersion ?? publishedCatalogVersion,
        against: "version",
      })
    : null

  const dirtyCompileSections = (diff?.sections ?? [])
    .map((s) => s.section)
    .filter((s) => COMPILE_CATALOG_SECTIONS.has(s))
  const dirtyOperationalSections = (diff?.sections ?? [])
    .map((s) => s.section)
    .filter((s) => OPERATIONAL_CATALOG_SECTIONS.has(s))

  // Missing historical snapshot: cannot prove env-only — treat tip ahead as compile-dirty.
  const missingPublishedSnapshot = publishedSnapshot == null
  const compileSectionDirty = missingPublishedSnapshot || dirtyCompileSections.length > 0

  const compileAffectedEntityIds = compileAffectedEntityIdsFromDiff({
    tip: tipSnapshot,
    published,
    diff: compileSectionDirty ? diff : null,
  })

  const hasCompileDelta =
    missingPublishedSnapshot
    || dirtyCompileSections.length > 0
    || compileAffectedEntityIds.length > 0
  const hasOperationalDelta = dirtyOperationalSections.length > 0

  // Tip stamp ahead with only environment deltas — live at preview/execute.
  const operationalOnlyAhead = tipAhead && !hasCompileDelta && hasOperationalDelta

  // Tip stamp ahead for any non-env reason arms Publish — including "zombie tip"
  // (version number ahead, live content matches publish) so UI cannot claim
  // published while activeVersion !== publishedCatalogVersion.
  const compileNeedsPublish = tipAhead ? !operationalOnlyAhead : hasCompileDelta

  return {
    activeCatalogVersion,
    publishedCatalogVersion,
    publishedAt,
    tipAhead,
    compileNeedsPublish,
    operationalOnlyAhead,
    dirtyCompileSections,
    dirtyOperationalSections,
    compileAffectedEntityIds,
    published,
    tipSnapshot,
    publishedSnapshot,
    diff,
  }
}
