import type {
  AuthoredSyncFlowStep,
  PublishedSyncDefinition,
  SyncFlowCatalogSnapshot,
  SyncFlowKindDefinition,
  SyncFlowPhaseDefinition,
  CustomValueSourceDefinition,
} from "@mia/shared-types"
import {
  collectCustomValueSourceIdsFromSteps,
  parseCustomValueSourceDefinition,
} from "@mia/shared-types"

import { parseKindDefinition, parsePhaseDefinition } from "./catalog-definition-parse.js"

export interface FlowCatalogRowPhase {
  id: string
  label: string
  definition_json?: string | null
}

export interface FlowCatalogRowKind {
  id: string
  label: string
  definition_json?: string | null
}

export interface FlowCatalogRowCustomValueSource {
  id: string
  label: string
  definition_json?: string | null
}

/** @deprecated Use FlowCatalogRowCustomValueSource */
export type FlowCatalogRowBindingSource = FlowCatalogRowCustomValueSource

export interface FlowCatalog {
  resolvePhase(phaseId: string): SyncFlowPhaseDefinition | undefined
  resolveKind(kindId: string): SyncFlowKindDefinition | undefined
  resolveCustomValueSource(id: string): CustomValueSourceDefinition | undefined
  resolveCustomValueSourceCatalog(): Record<string, CustomValueSourceDefinition>
  snapForSteps(steps: readonly AuthoredSyncFlowStep[]): SyncFlowCatalogSnapshot
}

function toRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries(entries)
}

function snapCustomValueSources(
  kindSnap: Record<string, SyncFlowKindDefinition>,
  steps: readonly AuthoredSyncFlowStep[],
  customSources: Map<string, CustomValueSourceDefinition>,
): Record<string, CustomValueSourceDefinition> {
  const ids = collectCustomValueSourceIdsFromSteps(kindSnap, steps)
  const snap: Record<string, CustomValueSourceDefinition> = {}
  for (const id of ids) {
    const def = customSources.get(id)
    if (def) snap[id] = def
  }
  return snap
}

export function buildFlowCatalog(
  phaseRows: readonly FlowCatalogRowPhase[],
  kindRows: readonly FlowCatalogRowKind[],
  customValueSourceRows: readonly FlowCatalogRowCustomValueSource[] = [],
): FlowCatalog {
  const phases = new Map<string, SyncFlowPhaseDefinition>()
  for (const row of phaseRows) {
    phases.set(row.id, parsePhaseDefinition(row.definition_json, row.id, row.label))
  }

  const kinds = new Map<string, SyncFlowKindDefinition>()
  for (const row of kindRows) {
    kinds.set(row.id, parseKindDefinition(row.definition_json, row.id, row.label))
  }

  const customValueSources = new Map<string, CustomValueSourceDefinition>()
  for (const row of customValueSourceRows) {
    customValueSources.set(
      row.id,
      parseCustomValueSourceDefinition(
        row.definition_json ? JSON.parse(row.definition_json) : {},
        row.id,
      ),
    )
  }

  return {
    resolvePhase(phaseId: string) {
      return phases.get(phaseId)
    },
    resolveKind(kindId: string) {
      return kinds.get(kindId)
    },
    resolveCustomValueSource(id: string) {
      return customValueSources.get(id)
    },
    resolveCustomValueSourceCatalog() {
      return Object.fromEntries(customValueSources)
    },
    snapForSteps(steps: readonly AuthoredSyncFlowStep[]): SyncFlowCatalogSnapshot {
      const snapPhases: Record<string, SyncFlowPhaseDefinition> = {}
      const snapKinds: Record<string, SyncFlowKindDefinition> = {}
      for (const step of steps) {
        if (step.phase) {
          const phaseDef = phases.get(step.phase)
          if (phaseDef) snapPhases[step.phase] = phaseDef
        }
        const kindDef = kinds.get(step.kind)
        if (kindDef) snapKinds[step.kind] = kindDef
      }
      return {
        phases: snapPhases,
        kinds: snapKinds,
        customValueSources: snapCustomValueSources(snapKinds, steps, customValueSources),
      }
    },
  }
}

export function flowCatalogFromSnapshot(snapshot: SyncFlowCatalogSnapshot): FlowCatalog {
  const phases = new Map<string, SyncFlowPhaseDefinition>(Object.entries(snapshot.phases))
  const kinds = new Map<string, SyncFlowKindDefinition>(Object.entries(snapshot.kinds))
  const customValueSources = new Map<string, CustomValueSourceDefinition>(
    Object.entries(snapshot.customValueSources ?? {}),
  )
  return {
    resolvePhase(phaseId) {
      return phases.get(phaseId)
    },
    resolveKind(kindId) {
      return kinds.get(kindId)
    },
    resolveCustomValueSource(id) {
      return customValueSources.get(id)
    },
    resolveCustomValueSourceCatalog() {
      return Object.fromEntries(customValueSources)
    },
    snapForSteps(steps) {
      const snapKinds = toRecord(
        [...new Set(steps.map((s) => s.kind))]
          .map((id) => [id, kinds.get(id)])
          .filter((entry): entry is [string, SyncFlowKindDefinition] => Boolean(entry[1])),
      )
      return {
        phases: toRecord(
          [...new Set(steps.map((s) => s.phase).filter(Boolean) as string[])]
            .map((id) => [id, phases.get(id)])
            .filter((entry): entry is [string, SyncFlowPhaseDefinition] => Boolean(entry[1])),
        ),
        kinds: snapKinds,
        customValueSources: snapCustomValueSources(snapKinds, steps, customValueSources),
      }
    },
  }
}

/** Frozen catalog on a published definition — required for preview/execute. */
export function requirePublishedFlowCatalog(
  definition: Pick<PublishedSyncDefinition, "id" | "executionFlow">,
): SyncFlowCatalogSnapshot {
  const catalog = definition.executionFlow.catalog
  if (!catalog) {
    throw new Error(
      `Published definition "${definition.id}" has no frozen flow catalog snapshot. Republish entity definitions.`,
    )
  }
  return {
    ...catalog,
    customValueSources: catalog.customValueSources ?? {},
  }
}
