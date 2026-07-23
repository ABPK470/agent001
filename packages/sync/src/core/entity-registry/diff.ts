/**
 * Structural diff between two EntityDefinition versions.
 *
 * Produces a list of EntityDefinitionChange records consumed by:
 *   - the wizard "what will change?" review step
 *   - the evidence envelope payload for the "edit entity" change-control event
 *
 * Pure function. No catalog calls.
 */

import type { EntityDefinition, EntityDefinitionChange, EntityTable } from "../../domain/entity-registry/types.js"

export function diffEntityDefinitions(
  prev: EntityDefinition | null,
  next: EntityDefinition
): EntityDefinitionChange[] {
  if (prev === null) {
    return [
      {
        kind: "created",
        tableName: null,
        description: `Created entity "${next.id}" (${next.displayName}) with ${next.tables.length} table(s).`
      }
    ]
  }

  const changes: EntityDefinitionChange[] = []

  // ── Retire / unretire ──────────────────────────────────────────
  if (prev.retiredAt === null && next.retiredAt !== null) {
    changes.push({
      kind: "retired",
      tableName: null,
      description: `Entity retired at ${next.retiredAt}.`,
      before: prev.retiredAt,
      after: next.retiredAt
    })
  } else if (prev.retiredAt !== null && next.retiredAt === null) {
    changes.push({
      kind: "unretired",
      tableName: null,
      description: "Entity unretired.",
      before: prev.retiredAt,
      after: null
    })
  }

  // ── Identity-shape changes ─────────────────────────────────────
  if (prev.displayName !== next.displayName) {
    changes.push({
      kind: "renamed",
      tableName: null,
      description: `displayName "${prev.displayName}" → "${next.displayName}".`,
      before: prev.displayName,
      after: next.displayName
    })
  }
  if (prev.rootTable !== next.rootTable) {
    changes.push({
      kind: "rootTableChanged",
      tableName: null,
      description: `rootTable "${prev.rootTable}" → "${next.rootTable}".`,
      before: prev.rootTable,
      after: next.rootTable
    })
  }
  if (prev.idColumn !== next.idColumn) {
    changes.push({
      kind: "idColumnChanged",
      tableName: null,
      description: `idColumn "${prev.idColumn}" → "${next.idColumn}".`,
      before: prev.idColumn,
      after: next.idColumn
    })
  }

  // ── SCD2 strategy reference ────────────────────────────────────
  if (
    prev.scd2.strategyId !== next.scd2.strategyId ||
    String(prev.scd2.strategyVersion) !== String(next.scd2.strategyVersion)
  ) {
    changes.push({
      kind: "scd2StrategyChanged",
      tableName: null,
      description: `SCD2 strategy "${prev.scd2.strategyId}@${String(prev.scd2.strategyVersion)}" → "${next.scd2.strategyId}@${String(next.scd2.strategyVersion)}".`,
      before: { id: prev.scd2.strategyId, version: prev.scd2.strategyVersion },
      after: { id: next.scd2.strategyId, version: next.scd2.strategyVersion }
    })
  }
  if (JSON.stringify(prev.scd2.entityOverride) !== JSON.stringify(next.scd2.entityOverride)) {
    changes.push({
      kind: "scd2OverrideChanged",
      tableName: null,
      description: "Entity-level SCD2 override changed.",
      before: prev.scd2.entityOverride,
      after: next.scd2.entityOverride
    })
  }

  // ── Table-by-table diff ───────────────────────────────────────
  const prevByName = new Map(prev.tables.map((t) => [t.name.toLowerCase(), t]))
  const nextByName = new Map(next.tables.map((t) => [t.name.toLowerCase(), t]))

  for (const [name, prevTable] of prevByName) {
    if (!nextByName.has(name)) {
      changes.push({
        kind: "tableRemoved",
        tableName: prevTable.name,
        description: `Removed table "${prevTable.name}".`
      })
    }
  }
  for (const [name, nextTable] of nextByName) {
    const prevTable = prevByName.get(name)
    if (!prevTable) {
      changes.push({
        kind: "tableAdded",
        tableName: nextTable.name,
        description: `Added table "${nextTable.name}" (executionOrder ${nextTable.executionOrder}).`
      })
      continue
    }
    diffTable(prevTable, nextTable, changes)
  }

  // ── Reorder detection (positions of common tables changed) ─────
  const prevOrder = prev.tables.map((t) => t.name.toLowerCase())
  const nextOrder = next.tables.map((t) => t.name.toLowerCase())
  if (commonElementsReordered(prevOrder, nextOrder)) {
    changes.push({
      kind: "tableReordered",
      tableName: null,
      description: "Table execution order changed.",
      before: prevOrder,
      after: nextOrder
    })
  }

  // ── Policies + lineage ─────────────────────────────────────────
  if (JSON.stringify(prev.policies) !== JSON.stringify(next.policies)) {
    changes.push({
      kind: "policiesChanged",
      tableName: null,
      description: "Policies changed (freeze windows).",
      before: prev.policies,
      after: next.policies
    })
  }
  if (JSON.stringify(prev.lineageRefs) !== JSON.stringify(next.lineageRefs)) {
    changes.push({
      kind: "lineageChanged",
      tableName: null,
      description: `Lineage refs changed (${prev.lineageRefs.length} → ${next.lineageRefs.length}).`,
      before: prev.lineageRefs,
      after: next.lineageRefs
    })
  }

  return changes
}

function diffTable(prev: EntityTable, next: EntityTable, out: EntityDefinitionChange[]): void {
  if (JSON.stringify(prev.scope) !== JSON.stringify(next.scope)) {
    out.push({
      kind: "scopeChanged",
      tableName: next.name,
      description: `Scope changed for "${next.name}" (${prev.scope.kind} → ${next.scope.kind}).`,
      before: prev.scope,
      after: next.scope
    })
  }
  if (prev.verified !== next.verified) {
    out.push({
      kind: "verifiedFlagChanged",
      tableName: next.name,
      description: `verified ${prev.verified} → ${next.verified} for "${next.name}".`,
      before: prev.verified,
      after: next.verified
    })
  }
  if (JSON.stringify(prev.scd2Override) !== JSON.stringify(next.scd2Override)) {
    out.push({
      kind: "scd2OverrideChanged",
      tableName: next.name,
      description: `Table-level SCD2 override changed for "${next.name}".`,
      before: prev.scd2Override,
      after: next.scd2Override
    })
  }
}

/**
 * Return true if the relative order of names that appear in BOTH lists
 * changed. Ignores added/removed names so they don't double-report.
 */
function commonElementsReordered(prev: string[], next: string[]): boolean {
  const nextSet = new Set(next)
  const prevSet = new Set(prev)
  const prevCommon = prev.filter((n) => nextSet.has(n))
  const nextCommon = next.filter((n) => prevSet.has(n))
  if (prevCommon.length !== nextCommon.length) return false
  for (let i = 0; i < prevCommon.length; i++) {
    if (prevCommon[i] !== nextCommon[i]) return true
  }
  return false
}
