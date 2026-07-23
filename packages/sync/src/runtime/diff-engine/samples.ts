/**
 * Sample-row fetchers for the diff engine.
 *
 * `fetchSamples` reads a small batch of rows from one pool by PK list
 * (used for INSERT and DELETE samples). `fetchUpdateSamples` reads the
 * same batch from BOTH pools and produces side-by-side
 * old/new/changedColumns triples for the UI's update preview.
 *
 * @module
 */

import type { SyncPlanRowSample } from "../../domain/plan.js"
import { buildBatchWhere, qtable } from "../../core/diff-engine/sql-helpers.js"
import type { PkHashRow } from "../../domain/diff-engine/types.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { runQueryWithRetry } from "./sql-query.js"

export async function fetchSamples(
  host: SyncRuntimeHost,
  connectionName: string,
  qualifiedTable: string,
  rows: PkHashRow[],
  pkColumns: string[],
  telemetryContext?: import("../../ports/events.js").SyncTelemetryContext
): Promise<SyncPlanRowSample[]> {
  if (rows.length === 0) return []
  try {
    const where = buildBatchWhere(rows, pkColumns)
    const result = await runQueryWithRetry(
      host,
      connectionName,
      `SELECT * FROM ${qtable(qualifiedTable)} WHERE ${where}`,
      `fetchSamples(${qualifiedTable})`,
      2,
      telemetryContext
    )
    // Re-order results to match input row order and build samples.
    const byPk = new Map<string, Record<string, unknown>>()
    for (const r of result.recordset as Record<string, unknown>[]) {
      const pk = pkColumns.map((c) => String(r[c] ?? "∅")).join("|")
      byPk.set(pk, r)
    }
    const samples: SyncPlanRowSample[] = []
    for (const row of rows) {
      const r = byPk.get(row.pk)
      if (r) samples.push({ values: r })
    }
    return samples
  } catch (e) {
    return [{ values: { error: e instanceof Error ? e.message : String(e) } }]
  }
}

export async function fetchUpdateSamples(
  host: SyncRuntimeHost,
  sourceConn: string,
  targetConn: string,
  qualifiedTable: string,
  rows: PkHashRow[],
  pkColumns: string[],
  excludeFromDiff: ReadonlySet<string> = new Set(),
  telemetryContext?: import("../../ports/events.js").SyncTelemetryContext
): Promise<SyncPlanRowSample[]> {
  if (rows.length === 0) return []
  try {
    const where = buildBatchWhere(rows, pkColumns)
    const qt = qtable(qualifiedTable)
    const [srcResult, tgtResult] = await Promise.all([
      runQueryWithRetry(
        host,
        sourceConn,
        `SELECT * FROM ${qt} WHERE ${where}`,
        `fetchUpdateSamples.src(${qualifiedTable})`,
        2,
        telemetryContext
      ),
      runQueryWithRetry(
        host,
        targetConn,
        `SELECT * FROM ${qt} WHERE ${where}`,
        `fetchUpdateSamples.tgt(${qualifiedTable})`,
        2,
        telemetryContext
      )
    ])
    const srcByPk = new Map<string, Record<string, unknown>>()
    for (const r of srcResult.recordset as Record<string, unknown>[]) {
      srcByPk.set(pkColumns.map((c) => String(r[c] ?? "∅")).join("|"), r)
    }
    const tgtByPk = new Map<string, Record<string, unknown>>()
    for (const r of tgtResult.recordset as Record<string, unknown>[]) {
      tgtByPk.set(pkColumns.map((c) => String(r[c] ?? "∅")).join("|"), r)
    }
    const samples: SyncPlanRowSample[] = []
    for (const row of rows) {
      const newValues = srcByPk.get(row.pk)
      const oldValues = tgtByPk.get(row.pk)
      const changedColumns: string[] = []
      if (newValues && oldValues) {
        for (const k of Object.keys(newValues)) {
          if (excludeFromDiff.has(k)) continue
          if (String(newValues[k]) !== String(oldValues[k])) changedColumns.push(k)
        }
      }
      samples.push({ newValues, oldValues, changedColumns })
    }
    return samples
  } catch (e) {
    return [{ values: { error: e instanceof Error ? e.message : String(e) } }]
  }
}
