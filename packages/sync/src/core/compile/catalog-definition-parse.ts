/**
 * Parse phase/kind definition JSON from DB or API bodies.
 *
 * No deploy business data here — only structural defaults for operator-created entries.
 */

import type { SyncFlowKindDefinition, SyncFlowPhaseDefinition } from "@mia/shared-types"
import { normalizeKindDefinition } from "@mia/shared-types"

export function defaultCustomPhaseDefinition(_id: string, label: string): SyncFlowPhaseDefinition {
  return {
    summary: label,
    description: "Custom phase — define when steps in this phase run and which connection they use.",
    boundary: "post_metadata",
    connection: "mixed",
    defaultFailureMode: "warning",
    orderingHint: "Place steps in the flow array; runtime partitions by phase boundary from the run catalog.",
  }
}

export function defaultCustomKindDefinition(id: string, label: string): SyncFlowKindDefinition {
  return normalizeKindDefinition({
    summary: label,
    description: "Custom step type — pick a handler type and configure it.",
    handler: {
      type: "mssql_procedure",
      connection: "target",
      procedure: "schema.uspCustomStep",
    },
    stepFields: {},
    failureMode: "warning",
  }, id)
}

export function parsePhaseDefinition(
  json: string | null | undefined,
  id: string,
  label: string,
): SyncFlowPhaseDefinition {
  if (!json || json === "{}") return defaultCustomPhaseDefinition(id, label)
  try {
    return JSON.parse(json) as SyncFlowPhaseDefinition
  } catch {
    return defaultCustomPhaseDefinition(id, label)
  }
}

export function parseKindDefinition(
  json: string | null | undefined,
  id: string,
  label: string,
): SyncFlowKindDefinition {
  if (!json || json === "{}") return defaultCustomKindDefinition(id, label)
  try {
    return normalizeKindDefinition(JSON.parse(json) as SyncFlowKindDefinition, id)
  } catch {
    return defaultCustomKindDefinition(id, label)
  }
}
