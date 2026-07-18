/**
 * Build legacy-activity-sync-specs.json from pipeline evidence + sync metadata.
 *
 * Pairs each in-scope activity ordinal (pipelineId:1-based scoped position) with its flow step and step type.
 * Activities whose `action` starts with "_" are omitted — they are internal MyMI rows.
 */

import { scopedPipelineActivities } from "./legacy-pipeline-evidence.mjs"
import { ENTITY_HINTS_BY_ENTRY_SPROC, isMetadataSyncEntryActivity } from "./sync-metadata-derivation.mjs"

export function activitySyncSpecKey(pipelineId, activityIndex) {
  return `${pipelineId}:${activityIndex + 1}`
}

export function buildLegacyActivitySyncSpecs(evidence, flowTemplateCatalog, syncMetadata) {
  const actions = syncMetadata.actions ?? syncMetadata.stepTypes ?? []
  const kindById = Object.fromEntries(actions.map((kind) => [kind.id, kind]))
  const specs = {}

  for (const pipeline of evidence.pipelines ?? []) {
    const entry = scopedPipelineActivities(pipeline.activities).find(isMetadataSyncEntryActivity)
    if (!entry?.storedProcedure) {
      throw new Error(`Pipeline ${pipeline.pipelineId} has no metadata sync entry activity in scoped rows.`)
    }

    const hint = ENTITY_HINTS_BY_ENTRY_SPROC[entry.storedProcedure]
    if (!hint) {
      throw new Error(`Unsupported legacy sync entry stored procedure ${entry.storedProcedure}.`)
    }

    const template = flowTemplateCatalog.flowTemplates?.[hint.entityId]
    if (!template) throw new Error(`Missing flow template for ${hint.entityId}`)

    const scopedActivities = scopedPipelineActivities(pipeline.activities)
    if (scopedActivities.length !== template.steps.length) {
      throw new Error(
        `Pipeline ${pipeline.pipelineId} scoped activity count (${scopedActivities.length}) != template steps (${template.steps.length}). ` +
          `Check for missing sync specs or unfiltered "_" action rows.`
      )
    }

    scopedActivities.forEach((activity, index) => {
      const step = template.steps[index]
      const stepTypeId = step.kind ?? "metadataSync"
      const kind = kindById[stepTypeId]
      if (!kind) throw new Error(`Missing step type ${stepTypeId} for ${hint.entityId} step ${step.id}`)

      const { id, phase, kind: kindField, title, description, ...params } = step
      const resolvedKind = kindField ?? stepTypeId
      specs[activitySyncSpecKey(pipeline.pipelineId, index)] = {
        stepTypeId: resolvedKind,
        stepType: {
          id: resolvedKind,
          label: kind.label,
          definition: kind.definition
        },
        step: { id, phase, kind: resolvedKind, title, description, ...params }
      }
    })
  }

  return {
    _comment:
      "Offline MyMI activity sync snapshot keyed by pipelineId:sequence. Live generators read properties.sync from core.Activity instead. Rows with action starting with '_' are excluded.",
    specs
  }
}
