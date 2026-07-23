/**
 * Tip-vs-shipped drift for built-in sync catalog rows.
 *
 * DB tip remains SoT. This only answers: "does this built-in still match
 * deploy/sync/artifacts/sync-metadata.json?" so the Configuration UI can tag it,
 * and builds a stable JSON pair for the Modified diff viewer.
 */

import type {
  AuthoredSyncFlowStep,
  CustomValueSourceDefinition,
  SyncFlowKindDefinition,
} from "@mia/shared-types"
import {
  normalizeKindDefinition,
  parseCustomValueSourceDefinition,
} from "@mia/shared-types"
import {
  loadSyncMetadataArtifact,
  type SyncMetadataArtifact,
} from "@mia/sync"
import { resolve } from "node:path"

import {
  buildFlowCatalogFromSyncMetadataDoc,
  prepareFlowStepsForStorage,
} from "../../../infra/persistence/sync-flow-steps.js"

export type ShippedDriftKind = "flows" | "actions" | "valueSources"

export interface ShippedDriftDiff {
  kind: ShippedDriftKind
  id: string
  label: string
  /** Pretty JSON of shipped artifact side (null if missing from artifact). */
  shippedJson: string | null
  /** Pretty JSON of current DB tip. */
  tipJson: string
  diverged: boolean
}

/** Stable JSON for structural equality (sorted object keys). */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** Pretty, key-sorted JSON for line diffs in the UI. */
export function prettyStableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2)
}

function canonicalize(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input
  if (Array.isArray(input)) return input.map(canonicalize)
  const obj = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key])
  }
  return out
}

function flowCatalogFromArtifact(metadata: SyncMetadataArtifact) {
  return buildFlowCatalogFromSyncMetadataDoc({
    phases: metadata.phases,
    actions: metadata.actions,
    valueSources: metadata.valueSources,
  })
}

function preparedFlowSteps(
  steps: readonly AuthoredSyncFlowStep[],
  metadata: SyncMetadataArtifact,
): AuthoredSyncFlowStep[] {
  return prepareFlowStepsForStorage([...steps], flowCatalogFromArtifact(metadata))
}

function preparedFlowStepsJson(
  steps: readonly AuthoredSyncFlowStep[],
  metadata: SyncMetadataArtifact,
): string {
  return stableJson(preparedFlowSteps(steps, metadata))
}

function flowSnapshot(
  id: string,
  flow: { label: string; description?: string; steps: AuthoredSyncFlowStep[] },
  metadata: SyncMetadataArtifact,
): unknown {
  let steps: AuthoredSyncFlowStep[]
  try {
    steps = preparedFlowSteps(flow.steps, metadata)
  } catch {
    steps = [...flow.steps]
  }
  return {
    id,
    label: flow.label,
    description: flow.description ?? "",
    steps,
  }
}

function actionSnapshot(
  id: string,
  action: { label: string; definition: SyncFlowKindDefinition },
): unknown {
  return {
    id,
    label: action.label,
    definition: normalizeKindDefinition(action.definition, id),
  }
}

function valueSourceSnapshot(
  id: string,
  source: { label: string; definition: CustomValueSourceDefinition },
): unknown {
  return {
    id,
    label: source.label,
    definition: parseCustomValueSourceDefinition(source.definition, id),
  }
}

export function builtInFlowDivergedFromShipped(input: {
  tip: { label: string; description: string; steps: AuthoredSyncFlowStep[] }
  shipped: { label: string; description?: string; steps: AuthoredSyncFlowStep[] } | undefined
  metadata: SyncMetadataArtifact
}): boolean {
  if (!input.shipped) return true
  if (input.tip.label !== input.shipped.label) return true
  if ((input.tip.description ?? "") !== (input.shipped.description ?? "")) return true
  try {
    return (
      preparedFlowStepsJson(input.tip.steps, input.metadata)
      !== preparedFlowStepsJson(input.shipped.steps, input.metadata)
    )
  } catch {
    // Tip or shipped steps fail prepare — treat as diverged so operators see a signal.
    return true
  }
}

export function builtInActionDivergedFromShipped(input: {
  tip: { label: string; definition: SyncFlowKindDefinition }
  shipped: { label: string; definition: SyncFlowKindDefinition } | undefined
  id: string
}): boolean {
  if (!input.shipped) return true
  if (input.tip.label !== input.shipped.label) return true
  return (
    stableJson(normalizeKindDefinition(input.tip.definition, input.id))
    !== stableJson(normalizeKindDefinition(input.shipped.definition, input.id))
  )
}

export function builtInValueSourceDivergedFromShipped(input: {
  tip: { label: string; definition: CustomValueSourceDefinition }
  shipped: { label: string; definition: CustomValueSourceDefinition } | undefined
  id: string
}): boolean {
  if (!input.shipped) return true
  if (input.tip.label !== input.shipped.label) return true
  const tip = parseCustomValueSourceDefinition(input.tip.definition, input.id)
  const shipped = parseCustomValueSourceDefinition(input.shipped.definition, input.id)
  return stableJson(tip) !== stableJson(shipped)
}

export function loadShippedSyncMetadata(projectRoot: string): SyncMetadataArtifact {
  return loadSyncMetadataArtifact(resolve(projectRoot))
}

export function annotateCatalogShippedDrift<
  TAction extends { id: string; label: string; builtIn: boolean; definition: SyncFlowKindDefinition },
  TFlow extends {
    id: string
    label: string
    description: string
    steps: AuthoredSyncFlowStep[]
    builtIn: boolean
  },
  TSource extends {
    id: string
    label: string
    builtIn: boolean
    definition: CustomValueSourceDefinition
  },
>(
  catalog: { actions: TAction[]; flows: TFlow[]; valueSources: TSource[] },
  metadata: SyncMetadataArtifact,
): {
  actions: Array<TAction & { divergedFromShipped: boolean }>
  flows: Array<TFlow & { divergedFromShipped: boolean }>
  valueSources: Array<TSource & { divergedFromShipped: boolean }>
} {
  const shippedActions = new Map(metadata.actions.map((row) => [row.id, row]))
  const shippedSources = new Map((metadata.valueSources ?? []).map((row) => [row.id, row]))

  return {
    actions: catalog.actions.map((row) => ({
      ...row,
      divergedFromShipped: row.builtIn
        ? builtInActionDivergedFromShipped({
            id: row.id,
            tip: { label: row.label, definition: row.definition },
            shipped: shippedActions.get(row.id),
          })
        : false,
    })),
    flows: catalog.flows.map((row) => ({
      ...row,
      divergedFromShipped: row.builtIn
        ? builtInFlowDivergedFromShipped({
            tip: { label: row.label, description: row.description, steps: row.steps },
            shipped: metadata.flows[row.id],
            metadata,
          })
        : false,
    })),
    valueSources: catalog.valueSources.map((row) => ({
      ...row,
      divergedFromShipped: row.builtIn
        ? builtInValueSourceDivergedFromShipped({
            id: row.id,
            tip: { label: row.label, definition: row.definition },
            shipped: shippedSources.get(row.id),
          })
        : false,
    })),
  }
}

export function buildShippedDriftDiff(input: {
  kind: ShippedDriftKind
  id: string
  tip:
    | { label: string; description: string; steps: AuthoredSyncFlowStep[] }
    | { label: string; definition: SyncFlowKindDefinition }
    | { label: string; definition: CustomValueSourceDefinition }
  metadata: SyncMetadataArtifact
}): ShippedDriftDiff {
  const { kind, id, tip, metadata } = input

  if (kind === "flows") {
    const flowTip = tip as { label: string; description: string; steps: AuthoredSyncFlowStep[] }
    const shipped = metadata.flows[id]
    const tipJson = prettyStableJson(flowSnapshot(id, flowTip, metadata))
    const shippedJson = shipped ? prettyStableJson(flowSnapshot(id, shipped, metadata)) : null
    return {
      kind,
      id,
      label: flowTip.label,
      shippedJson,
      tipJson,
      diverged: builtInFlowDivergedFromShipped({ tip: flowTip, shipped, metadata }),
    }
  }

  if (kind === "actions") {
    const actionTip = tip as { label: string; definition: SyncFlowKindDefinition }
    const shipped = metadata.actions.find((row) => row.id === id)
    const tipJson = prettyStableJson(actionSnapshot(id, actionTip))
    const shippedJson = shipped ? prettyStableJson(actionSnapshot(id, shipped)) : null
    return {
      kind,
      id,
      label: actionTip.label,
      shippedJson,
      tipJson,
      diverged: builtInActionDivergedFromShipped({ id, tip: actionTip, shipped }),
    }
  }

  const sourceTip = tip as { label: string; definition: CustomValueSourceDefinition }
  const shipped = (metadata.valueSources ?? []).find((row) => row.id === id)
  const tipJson = prettyStableJson(valueSourceSnapshot(id, sourceTip))
  const shippedJson = shipped ? prettyStableJson(valueSourceSnapshot(id, shipped)) : null
  return {
    kind,
    id,
    label: sourceTip.label,
    shippedJson,
    tipJson,
    diverged: builtInValueSourceDivergedFromShipped({ id, tip: sourceTip, shipped }),
  }
}
