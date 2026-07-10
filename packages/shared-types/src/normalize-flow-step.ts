/**
 * Canonical defaults for authored flow step instance fields.
 */

import type { AuthoredSyncFlowStep, SyncFlowKindDefinition } from "./index.js"
import type { SyncStepFieldKey } from "./value-source.js"
import { requiredStepBoundSlotNames, stepFieldKeysForStep } from "./flow-step-bindings.js"
import type { ValueSource } from "./value-source.js"

const ENTITY_AUDIT_OBJECT_TYPE: Record<string, string> = {
  contract: "Contract",
  dataset: "Dataset",
  rule: "Rule",
  content: "Content",
  pipelineActivity: "Pipeline",
  gateMetadata: "MetaTable",
}

export interface FlowStepKindLookup {
  resolveKind(kindId: string): SyncFlowKindDefinition | undefined
}

export function defaultAuditObjectType(kind: AuthoredSyncFlowStep["kind"], entityId: string): string {
  if (kind === "rulesDeploy") return "Rule"
  if (kind === "datasetDeploy") return "Dataset"
  if (kind === "syncDate" || kind === "deployDate") {
    return ENTITY_AUDIT_OBJECT_TYPE[entityId] ?? "Contract"
  }
  return ENTITY_AUDIT_OBJECT_TYPE[entityId] ?? "Contract"
}

export function defaultObjectName(kind: AuthoredSyncFlowStep["kind"], entityId: string): string {
  if (kind === "handleDependencies") return entityId === "content" ? "content" : entityId
  if (kind.startsWith("contract")) return "Contract"
  if (kind.startsWith("dataset") || kind === "rulesDeploy") return "Dataset"
  return ENTITY_AUDIT_OBJECT_TYPE[entityId] ?? "Contract"
}

export function derivePipelineName(rootTable: string): string {
  const tableName = rootTable.trim().split(".").filter(Boolean).at(-1) ?? "Entity"
  return `Synchronize ${tableName}`
}

function defaultForStepField(
  field: SyncStepFieldKey,
  kind: AuthoredSyncFlowStep["kind"],
  entityId: string,
  rootTable?: string,
): string {
  switch (field) {
    case "auditObjectType":
      return defaultAuditObjectType(kind, entityId)
    case "objectName":
      return defaultObjectName(kind, entityId)
    case "pipelineName":
      return derivePipelineName(rootTable ?? "schema.Entity")
    default:
      return ""
  }
}

/** Suggested default when a step field is unset — not forced over explicit empty strings. */
export function defaultStepFieldValue(
  field: SyncStepFieldKey,
  kind: AuthoredSyncFlowStep["kind"],
  entityId: string,
  rootTable?: string,
): string {
  return defaultForStepField(field, kind, entityId, rootTable)
}

/** Default bindings when adding a new step in the flow editor. */
export function defaultStepBindings(
  step: Pick<AuthoredSyncFlowStep, "kind">,
  entityId: string,
  kindDef: SyncFlowKindDefinition | undefined,
): Record<string, ValueSource> {
  if (!kindDef) return {}
  const bindings: Record<string, ValueSource> = {}
  for (const slotName of requiredStepBoundSlotNames(kindDef.handler)) {
    if (step.kind === "datasetDeploy" && slotName === "datasetId") {
      bindings.datasetId =
        entityId === "rule"
          ? { type: "catalog", id: "ruleInputDatasetId" }
          : { type: "catalog", id: "planEntityId" }
    } else if (step.kind === "pipelineRegister" && slotName === "pipelineId") {
      bindings.pipelineId =
        entityId === "pipelineActivity"
          ? { type: "catalog", id: "planEntityId" }
          : { type: "catalog", id: "contractPipelineId" }
    }
  }
  return bindings
}

export interface NormalizeFlowStepContext {
  entityId: string
  rootTable?: string
}

export function normalizeAuthoredSyncFlowStep(
  step: AuthoredSyncFlowStep,
  context: NormalizeFlowStepContext,
  catalog?: FlowStepKindLookup,
): AuthoredSyncFlowStep {
  const kindDef = catalog?.resolveKind(step.kind)
  const bindings = step.bindings ?? {}
  const next: AuthoredSyncFlowStep = { ...step, bindings }

  for (const field of stepFieldKeysForStep(step, kindDef)) {
    const current = next[field]
    if (current !== undefined) continue
    const fallback = defaultStepFieldValue(field, step.kind, context.entityId, context.rootTable)
    if (fallback) {
      next[field] = fallback
    }
  }

  return next
}

export function normalizeAuthoredSyncFlowSteps(
  steps: readonly AuthoredSyncFlowStep[],
  context: NormalizeFlowStepContext,
  catalog?: FlowStepKindLookup,
): AuthoredSyncFlowStep[] {
  return steps.map((step) => normalizeAuthoredSyncFlowStep(step, context, catalog))
}
