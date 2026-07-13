import type { OperationActivity, OperationEvent } from "./api"
import { isAgentStepEventType } from "./tool-call-io"
import { isSyncSqlEventType, readSqlTraceFields, type SqlTraceFields } from "./sync-sql-trace"

export type TraceKind = "sql" | "shell" | "script" | "io" | "event"

export interface TraceRowDescriptor {
  kind: TraceKind
  /** Primary label, e.g. "FetchPkColumns(Core Activity)" or "auditCheck". */
  step: string
  connection?: string
  durationMs?: number | null
  detailLabel: string
  sqlFields?: SqlTraceFields
}

export function traceKindForEvent(ev: OperationEvent): TraceKind {
  if (isSyncSqlEventType(ev.type)) return "sql"
  if (isAgentStepEventType(ev.type)) return "io"
  if (typeof ev.data["command"] === "string" || ev.type.includes("sandbox")) return "shell"
  if (typeof ev.data["script"] === "string") return "script"
  return "event"
}

export function detailLabelForKind(kind: TraceKind): string {
  switch (kind) {
    case "sql":
      return "SQL"
    case "io":
      return "I/O"
    case "shell":
      return "CMD"
    case "script":
      return "Script"
    default:
      return "Detail"
  }
}

export function kindPrefixForKind(kind: TraceKind): string {
  switch (kind) {
    case "sql":
      return "SQL"
    case "io":
      return "Step"
    case "shell":
      return "CMD"
    case "script":
      return "Script"
    default:
      return "Event"
  }
}

/** Normalize activity / event labels into a short step name. */
export function normalizeTraceStepName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("SQL · ")) return trimmed.slice("SQL · ".length)
  const flow = trimmed.match(/^flowStep\.[^(]+\(([^)]+)\)$/)
  if (flow?.[1]) return flow[1]
  const contract = trimmed.match(/^contractDeploy\.[^(]+\(([^)]+)\)$/)
  if (contract?.[1]) return contract[1]
  return trimmed
}

export function describeSqlEvent(ev: OperationEvent, activity?: OperationActivity): TraceRowDescriptor {
  const fields = readSqlTraceFields(ev.data)
  const step =
    activity != null
      ? normalizeTraceStepName(activity.name)
      : normalizeTraceStepName(fields?.label ?? "query")
  return {
    kind: "sql",
    step,
    connection: fields?.connection ?? activity?.summary ?? undefined,
    durationMs: fields?.durationMs ?? activity?.durationMs ?? null,
    detailLabel: "SQL",
    sqlFields: fields ?? undefined,
  }
}

export function describeSqlOnlyActivity(activity: OperationActivity): TraceRowDescriptor {
  const ev = activity.events[0]
  return describeSqlEvent(ev!, activity)
}

/** Inline summary: "SQL FetchPkColumns(Core Activity) · uat · 415ms" */
export function formatTraceRowSummary(desc: TraceRowDescriptor): string {
  const parts = [`${kindPrefixForKind(desc.kind)} ${desc.step}`]
  if (desc.connection) parts.push(desc.connection)
  if (desc.durationMs != null) parts.push(`${desc.durationMs}ms`)
  return parts.join(" · ")
}
