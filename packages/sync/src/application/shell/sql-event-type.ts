import type { EventType as SyncEventType } from "../../domain/enums.js"
import { EventType, SyncOperationType as SyncOp } from "../../domain/enums.js"
import type { SyncTelemetryContext } from "../../ports/events.js"

/** Map telemetry context → persisted SSE / event_log type for SQL rows. */
export function resolveSyncSqlEventType(ctx?: SyncTelemetryContext): SyncEventType {
  if (ctx?.scope === "discovery") return EventType.SyncDiscoverySql
  if (ctx?.scope === "catalog") return EventType.SyncCatalogSql
  if (ctx?.kind === SyncOp.Execute) return EventType.SyncExecuteSql
  return EventType.SyncPreviewSql
}
