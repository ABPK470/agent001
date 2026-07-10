/**
 * Sync metadata derivation — step types and flows from MyMI pipeline evidence.
 *
 * Ground truth per activity: core.Activity.properties JSON (`sync` block).
 * Metadata entry activities (uspSync*ObjectsTran) infer the metadataSync step type.
 * Offline fixtures may supply legacy-activity-sync-specs.json keyed by "pipelineId:sequence".
 */

import {
  isScopedPipelineActivity,
  loadLegacyActivitySyncSpecs,
  scopedPipelineActivities
} from "./legacy-pipeline-evidence.mjs"
import { migrateFlowStep, migrateKindDefinition } from "./sync-metadata-normalize.mjs"
import { SYNC_METADATA_PHASES, SYNC_METADATA_PHASE_IDS } from "./sync-metadata-phases.mjs"
import { VALUE_SOURCE_SEEDS } from "./value-source-seeds.mjs"

const METADATA_ONLY_FLOW = {
  label: "Metadata only",
  description: "Only apply metadata changes; do not trigger downstream deploy or refresh steps.",
  steps: [
    {
      id: "metadataSync",
      phase: "metadata",
      kind: "metadataSync",
      title: "Metadata sync",
      description: "Apply transactional metadata changes for the selected entity scope."
    }
  ]
}

/** Links legacy entry sprocs to entity-scoped flow ids (pipeline linkage, not step handlers). */
export const ENTITY_HINTS_BY_ENTRY_SPROC = {
  "core.uspSyncContentObjectsTran": {
    entityId: "content",
    label: "Content dependencies",
    description: "Metadata sync followed by downstream dependency refresh for content entities.",
    metadataDescription: "Apply transactional metadata changes for the selected content scope."
  },
  "core.uspSyncDataListObjectsTran": {
    entityId: "gateMetadata",
    label: "Gate refresh",
    description: "Metadata sync followed by gate metadata refresh and downstream pipeline start.",
    metadataDescription: "Apply transactional metadata changes for the selected gate metadata scope."
  },
  "core.uspSyncCoreObjectsTran": {
    entityId: "contract",
    label: "Contract deploy",
    description: "Metadata sync plus full contract deployment, ETL, routines, and deploy stamps.",
    metadataDescription: "Apply transactional metadata changes for the selected contract scope."
  },
  "core.uspSyncRuleObjectsTran": {
    entityId: "rule",
    label: "Rule deploy",
    description: "Metadata sync, dependent dataset deploy, rule deploy, and dependency refresh.",
    metadataDescription: "Apply transactional metadata changes for the selected rule scope."
  },
  "core.uspSyncDatasetObjectsTran": {
    entityId: "dataset",
    label: "Dataset deploy",
    description: "Metadata sync followed by dataset deployment on the target ETL service.",
    metadataDescription: "Apply transactional metadata changes for the selected dataset scope."
  },
  "core.uspSyncPipelineObjectsTran": {
    entityId: "pipelineActivity",
    label: "Pipeline register",
    description: "Metadata sync followed by registering the target pipeline with the agent service.",
    metadataDescription: "Apply transactional metadata changes for the selected pipeline activity scope."
  }
}

const STEP_INSTANCE_KEYS = new Set(["id", "phase", "kind", "title", "description"])

/** Entity-scoped default bindings for generated flows (per-flow value sources only). */
export function applyDefaultFlowStepBindings(step, entityId) {
  const kind = step.kind
  const bindings = { ...(step.bindings ?? {}) }

  if (kind === "datasetDeploy") {
    bindings.datasetId = entityId === "rule" ? { type: "ruleInputDatasetId" } : { type: "planEntityId" }
  }
  if (kind === "pipelineRegister") {
    bindings.pipelineId =
      entityId === "pipelineActivity" ? { type: "planEntityId" } : { type: "contractPipelineId" }
  }

  for (const [slot, source] of Object.entries(bindings)) {
    if (source && typeof source === "object" && source.type === "stepField") delete bindings[slot]
  }

  if (Object.keys(bindings).length === 0) return step
  return { ...step, bindings }
}

const METADATA_SYNC_STEP_TYPE = {
  id: "metadataSync",
  label: "Apply metadata change set",
  definition: {
    summary: "Apply metadata change set",
    description:
      "Runs the core metadata sync in one target transaction: FK NOCHECK, MERGE/DELETE from the compiled change set, re-enable FKs, commit.",
    handler: { type: "metadata_sync", connection: "target" },
    failureMode: "fatal",
    entityTypes: ["any"]
  }
}

export function parseActivityProperties(activity) {
  const raw = activity?.properties
  if (!raw) return {}
  if (typeof raw === "object") return raw
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return {}
}

export function isMetadataSyncEntryActivity(activity) {
  const proc = activity?.storedProcedure ?? parseActivityProperties(activity).storedProcedure
  return typeof proc === "string" && /^core\.uspSync.*ObjectsTran$/i.test(proc)
}

export function activitySpecKey(pipelineId, activity) {
  return `${pipelineId}:${activity.sequence}`
}

function resolveActivityOverlaySpec(
  pipelineId,
  activity,
  scopedActivities,
  activityIndex,
  activitySyncSpecs
) {
  const ordinalActivity = scopedActivities?.[activityIndex]
  if (!ordinalActivity) return null

  const ordinalKey = `${pipelineId}:${activityIndex + 1}`
  const ordinal = activitySyncSpecs?.[ordinalKey]
  if (ordinal) return ordinal

  const exactKey = activitySpecKey(pipelineId, activity)
  if (ordinalKey === exactKey) return null
  return activitySyncSpecs?.[exactKey] ?? null
}

export function selectPipelineEntityHint(pipeline) {
  const entry = scopedPipelineActivities(pipeline.activities).find(isMetadataSyncEntryActivity)
  if (!entry?.storedProcedure) {
    throw new Error(`Pipeline ${pipeline.pipelineId} does not expose a legacy sync entry stored procedure.`)
  }
  const hint = ENTITY_HINTS_BY_ENTRY_SPROC[entry.storedProcedure]
  if (!hint) {
    throw new Error(`Unsupported legacy sync entry stored procedure ${entry.storedProcedure}.`)
  }
  return hint
}

export function phaseForActivityIndex(scopedActivities, activityIndex) {
  const metadataIndex = scopedActivities.findIndex(isMetadataSyncEntryActivity)
  if (metadataIndex < 0) throw new Error("Scoped pipeline activities have no metadata sync entry.")
  if (activityIndex < metadataIndex) return "preTransaction"
  if (activityIndex === metadataIndex) return "metadata"
  return "postMetadata"
}

function metadataSyncSpecForActivity(activity, entityHint) {
  return {
    stepTypeId: "metadataSync",
    stepType: METADATA_SYNC_STEP_TYPE,
    step: {
      id: "metadataSync",
      phase: "metadata",
      kind: "metadataSync",
      title: "Metadata sync",
      description: entityHint.metadataDescription
    }
  }
}

function normalizeSyncSpec(rawSpec, activity, scopedActivities, activityIndex, entityHint) {
  const stepTypeId = rawSpec.stepTypeId ?? rawSpec.kind
  if (!stepTypeId) {
    throw new Error(
      `Activity ${activity.activityName} (seq ${activity.sequence}) is missing stepTypeId in sync spec.`
    )
  }

  const stepType = rawSpec.stepType ?? {
    id: stepTypeId,
    label: rawSpec.stepTypeLabel ?? rawSpec.title ?? activity.activityName,
    definition: rawSpec.definition
  }
  if (!stepType.definition?.handler) {
    throw new Error(
      `Activity ${activity.activityName} (seq ${activity.sequence}) step type ${stepTypeId} is missing handler definition.`
    )
  }

  const stepParams = rawSpec.step ?? rawSpec
  const phase =
    stepParams.phase ??
    rawSpec.phase ??
    (isMetadataSyncEntryActivity(activity)
      ? "metadata"
      : phaseForActivityIndex(scopedActivities, activityIndex))

  const step = {
    id: stepParams.id ?? stepParams.stepId ?? slugify(activity.activityName),
    phase,
    kind: stepTypeId,
    title: stepParams.title ?? activity.activityName,
    description: stepParams.description ?? stepType.definition.summary ?? "",
    ...extractStepParams(stepParams)
  }

  if (!SYNC_METADATA_PHASE_IDS.has(step.phase)) {
    throw new Error(`Activity ${activity.activityName} references unknown phase ${step.phase}.`)
  }

  return {
    stepTypeId,
    stepType: {
      id: stepTypeId,
      label: stepType.label ?? stepType.definition.summary ?? stepTypeId,
      definition: stepType.definition
    },
    step
  }
}

export function resolveActivitySyncSpec(activity, pipeline, scopedActivities, activityIndex, options = {}) {
  if (!isScopedPipelineActivity(activity)) {
    throw new Error(
      `Activity "${activity.activityName}" (pipeline ${pipeline.pipelineId}, seq ${activity.sequence}) is excluded (action starts with "_").`
    )
  }

  const props = parseActivityProperties(activity)
  const embedded = props.sync ?? props.miaSync
  if (embedded) {
    return normalizeSyncSpec(embedded, activity, scopedActivities, activityIndex, options.entityHint)
  }

  if (isMetadataSyncEntryActivity(activity)) {
    return metadataSyncSpecForActivity(activity, options.entityHint ?? selectPipelineEntityHint(pipeline))
  }

  const overlayKey = activitySpecKey(pipeline.pipelineId, activity)
  const overlay = resolveActivityOverlaySpec(
    pipeline.pipelineId,
    activity,
    scopedActivities,
    activityIndex,
    options.activitySyncSpecs
  )
  if (overlay) {
    return normalizeSyncSpec(overlay, activity, scopedActivities, activityIndex, options.entityHint)
  }

  throw new Error(
    `Activity "${activity.activityName}" (pipeline ${pipeline.pipelineId}, seq ${activity.sequence}) has no sync metadata. ` +
      `Expected properties.sync on the MyMI row or an offline spec at ${overlayKey}.`
  )
}

export function buildSyncMetadataFromPipelines(pipelines, options = {}) {
  const stepTypes = new Map()
  const flows = {}

  for (const pipeline of pipelines) {
    const scopedActivities = scopedPipelineActivities(pipeline.activities)
    const entityHint = selectPipelineEntityHint(pipeline)
    const steps = []

    scopedActivities.forEach((activity, activityIndex) => {
      const resolved = resolveActivitySyncSpec(activity, pipeline, scopedActivities, activityIndex, {
        ...options,
        entityHint
      })
      if (!stepTypes.has(resolved.stepTypeId)) {
        stepTypes.set(resolved.stepTypeId, resolved.stepType)
      }
      steps.push(migrateFlowStep(applyDefaultFlowStepBindings(resolved.step, entityHint.entityId)))
    })

    if (steps.length === 0) {
      throw new Error(`Pipeline ${pipeline.pipelineId} did not yield any flow steps.`)
    }

    flows[entityHint.entityId] = {
      label: entityHint.label,
      description: entityHint.description,
      steps
    }
  }

  flows["metadataOnly"] = {
    label: METADATA_ONLY_FLOW.label,
    description: METADATA_ONLY_FLOW.description,
    steps: METADATA_ONLY_FLOW.steps.map((step) => ({ ...step }))
  }

  if (!stepTypes.has("metadataSync")) {
    stepTypes.set("metadataSync", METADATA_SYNC_STEP_TYPE)
  }

  const metadata = {
    version: 1,
    _comment:
      "MyMI-derived sync vocabulary: step types (reusable handlers) and flows (ordered step instances). Seeds DB-backed config; operators may edit after bootstrap.",
    phases: SYNC_METADATA_PHASES.map((phase) => ({ ...phase, definition: { ...phase.definition } })),
    stepTypes: sortStepTypes(stepTypes),
    customValueSources: VALUE_SOURCE_SEEDS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      definition: structuredClone(entry.definition),
    })),
    flows
  }
  enrichStepTypeEntityTypesFromFlows(metadata)
  for (const stepType of metadata.stepTypes ?? []) {
    stepType.definition = migrateKindDefinition(stepType.definition, stepType.id)
  }
  for (const flow of Object.values(metadata.flows ?? {})) {
    flow.steps = (flow.steps ?? []).map((step) => migrateFlowStep(step))
  }
  return metadata
}

/** Union entity ids from flow usage into each step type's entityTypes (unless already `any`). */
export function enrichStepTypeEntityTypesFromFlows(syncMetadata) {
  const usage = new Map()
  for (const [entityId, flow] of Object.entries(syncMetadata.flows ?? {})) {
    if (entityId === "metadataOnly") continue
    for (const step of flow.steps ?? []) {
      if (!step?.kind) continue
      if (!usage.has(step.kind)) usage.set(step.kind, new Set())
      usage.get(step.kind).add(entityId)
    }
  }

  for (const stepType of syncMetadata.stepTypes ?? []) {
    const usedBy = usage.get(stepType.id)
    if (!usedBy?.size) continue
    const definition = stepType.definition ?? {}
    const existing = new Set(definition.entityTypes ?? [])
    if (existing.has("any")) continue
    for (const entityId of usedBy) existing.add(entityId)
    definition.entityTypes = [...existing].sort()
    stepType.definition = definition
  }
}

/** Flow-template catalog view — same shape as legacy flow-templates.json for loaders. */
export function buildFlowTemplateCatalogFromSyncMetadata(syncMetadata) {
  return {
    version: 1,
    _comment: syncMetadata._comment,
    flowTemplates: syncMetadata.flows
  }
}

/** Build flow-template catalog directly from pipeline evidence (offline specs overlay when needed). */
export function buildFlowTemplateCatalogFromPipelines(pipelines, options = {}) {
  const activitySyncSpecs = {
    ...loadLegacyActivitySyncSpecs(options.specsPath),
    ...(options.activitySyncSpecs ?? {})
  }
  return buildFlowTemplateCatalogFromSyncMetadata(
    buildSyncMetadataFromPipelines(pipelines, { ...options, activitySyncSpecs })
  )
}

export function validateSyncMetadataCoversFlows(syncMetadata) {
  const stepTypeIds = new Set(syncMetadata.stepTypes.map((stepType) => stepType.id))
  const phaseIds = new Set(syncMetadata.phases.map((phase) => phase.id))
  const referencedKinds = new Set()
  const referencedPhases = new Set()

  for (const flow of Object.values(syncMetadata.flows ?? {})) {
    for (const step of flow.steps ?? []) {
      if (step?.kind) referencedKinds.add(step.kind)
      if (step?.phase) referencedPhases.add(step.phase)
    }
  }

  const missingKinds = [...referencedKinds].filter((id) => !stepTypeIds.has(id)).sort()
  const missingPhases = [...referencedPhases].filter((id) => !phaseIds.has(id)).sort()
  if (missingKinds.length > 0 || missingPhases.length > 0) {
    const parts = []
    if (missingKinds.length > 0) parts.push(`step types: ${missingKinds.join(", ")}`)
    if (missingPhases.length > 0) parts.push(`phases: ${missingPhases.join(", ")}`)
    throw new Error(`Sync metadata missing flow references (${parts.join("; ")})`)
  }

  return {
    referencedKinds: [...referencedKinds].sort(),
    referencedPhases: [...referencedPhases].sort()
  }
}

function sortStepTypes(stepTypes) {
  const entries = [...stepTypes.values()]
  entries.sort((left, right) => {
    if (left.id === "metadataSync") return -1
    if (right.id === "metadataSync") return 1
    return left.id.localeCompare(right.id)
  })
  return entries
}

function extractStepParams(stepParams) {
  return Object.fromEntries(
    Object.entries(stepParams).filter(([key]) => !STEP_INSTANCE_KEYS.has(key) && key !== "stepId")
  )
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
