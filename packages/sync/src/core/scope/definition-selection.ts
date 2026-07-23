/**
 * Runtime table selection for a published sync definition.
 */

import type { AuthoredSyncDefinitionTable, PublishedSyncDefinition } from "@mia/shared-types"

import { DiscoverySource } from "./enums.js"

export type SyncEntityId = string

export interface ActiveDefinitionTableSelection {
  tables: AuthoredSyncDefinitionTable[]
  executionOrder: string[]
  reverseOrder: string[]
}

export function selectDefinitionTables(
  definition: PublishedSyncDefinition,
  enabledOptionalTables: string[] | undefined
): ActiveDefinitionTableSelection {
  const enabledOptional = new Set(enabledOptionalTables ?? [])
  const tables = definition.metadata.tables.filter((table) => isTableEnabled(table, enabledOptional))
  const activeNames = new Set(tables.map((table) => table.name))
  return {
    tables,
    executionOrder: definition.metadata.executionOrder.filter((tableName) => activeNames.has(tableName)),
    reverseOrder: definition.metadata.reverseOrder.filter((tableName) => activeNames.has(tableName))
  }
}

function normalizeTable(table: AuthoredSyncDefinitionTable): AuthoredSyncDefinitionTable {
  const groundedByPipeline = table.groundedByPipeline ?? table.source !== DiscoverySource.FkOnly
  const userControllable = table.userControllable ?? !groundedByPipeline
  const enabledByDefault = table.enabledByDefault ?? !userControllable
  return {
    ...table,
    groundedByPipeline,
    userControllable,
    enabledByDefault
  }
}

function isTableEnabled(table: AuthoredSyncDefinitionTable, enabledOptional: Set<string>): boolean {
  const normalized = normalizeTable(table)
  if (!normalized.userControllable) return normalized.enabledByDefault !== false
  return enabledOptional.has(normalized.name) || normalized.enabledByDefault === true
}
