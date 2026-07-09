/**
 * Per-run schema verification — tables the agent has explicitly inspected
 * via search_catalog(table=), explore_mssql_schema(table=), or profile_data.
 *
 * query_mssql blocks references to catalog tables not in this set so the
 * agent cannot join dim.Client using guessed column names after only
 * exploring publish.Revenue.
 *
 * @module
 */

import type { RunContext } from "../../application/shell/runtime.js"

/** Record a schema-qualified table as verified for this run. */
export function markMssqlTableVerified(run: RunContext | undefined, qualifiedName: string): void {
  if (!run || !qualifiedName.includes(".")) return
  run.mssqlVerifiedTables.add(qualifiedName.toLowerCase())
}

/** Seed verification from known_objects / goal anchors at run start. */
export function seedMssqlVerifiedTables(run: RunContext | undefined, qnames: Iterable<string>): void {
  if (!run) return
  for (const q of qnames) markMssqlTableVerified(run, q)
}

/** Mirror profile_data tracking — both sets stay aligned. */
export function markMssqlTableProfiled(run: RunContext | undefined, qualifiedName: string): void {
  if (!run || !qualifiedName.includes(".")) return
  const key = qualifiedName.toLowerCase()
  run.mssqlProfileCalls.add(key)
  run.mssqlVerifiedTables.add(key)
}
