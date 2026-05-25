import { PlannerTraceKind } from "@mia/agent"
import { MSSQL_DOCTRINES } from "../../doctrine/index.js"
import { emitToolTrace, type ToolTraceContext } from "../../loop/index.js"
import type { QueryValidationDiagnostics } from "./validation.js"

const SQL_PREVIEW_MAX_CHARS = 600

function previewSql(query: string): string {
  return query.length > SQL_PREVIEW_MAX_CHARS
    ? query.slice(0, SQL_PREVIEW_MAX_CHARS) + `… [+${query.length - SQL_PREVIEW_MAX_CHARS} chars]`
    : query
}

/** Snapshot of all active doctrine module versions, recomputed per emit. */
function currentDoctrineVersions(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of MSSQL_DOCTRINES) out[d.id] = d.version
  return out
}

export function emitMssqlQualityTrace(input: {
  toolMode: "query" | "export"
  phase: "blocked" | "executed" | "failed"
  query: string
  connection: string
  database?: string | null
  validation: QueryValidationDiagnostics
  durationMs?: number
  rowCount?: number
  error?: string
}, trace: ToolTraceContext | null = null): void {
  emitToolTrace(trace, {
    kind: PlannerTraceKind.SqlQuality,
    toolMode: input.toolMode,
    phase: input.phase,
    connection: input.connection,
    database: input.database ?? null,
    validationOk: input.validation.ok,
    validationCode: input.validation.code,
    largeObjectRefs: input.validation.analysis.largeObjectRefs,
    usesPersistedMirrors: input.validation.analysis.usesPersistedMirrors,
    missingPersistedMirrorCandidates: input.validation.analysis.missingPersistedMirrorCandidates,
    hasWhereClause: input.validation.analysis.hasWhereClause,
    unsafeScanReason: input.validation.analysis.unsafeScanReason,
    tempTableRefs: input.validation.analysis.tempTableRefs,
    tempTablesCreated: input.validation.analysis.tempTablesCreated,
    tempTableSuffixes: input.validation.analysis.tempTableSuffixes,
    malformedTempSuffixes: input.validation.analysis.malformedTempSuffixes,
    missingTempCreations: input.validation.analysis.missingTempCreations,
    aggregateWarningCount: input.validation.analysis.aggregateWarningCount,
    aggregateBlockCount: input.validation.analysis.aggregateBlockCount,
    tempScalarSubqueryCount: input.validation.analysis.tempScalarSubqueryCount,
    stagePatternLikely: input.validation.analysis.stagePatternLikely,
    durationMs: input.durationMs ?? null,
    rowCount: input.rowCount ?? null,
    error: input.error ?? null,
    sqlPreview: previewSql(input.query),
    sqlLength: input.query.length,
    doctrineVersions: currentDoctrineVersions(),
  })
}