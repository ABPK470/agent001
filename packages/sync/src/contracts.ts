import sql from "mssql"
import type { SyncEnvironment } from "./environments.js"
import type { SyncPlan } from "./plan-store.js"
import type { SyncRecipeBundle } from "./recipes.js"
import type { SyncEventSink } from "./sync-events.js"
import type { SyncRunSink } from "./sync-run-sink.js"

export { EventType, SyncProgressKind, SyncRunStatus } from "@mia/shared-enums"

export const EnvRole = {
  Source: "source",
  Target: "target",
  Both: "both",
} as const
export type EnvRole = (typeof EnvRole)[keyof typeof EnvRole]
export const ENV_ROLES: ReadonlyArray<EnvRole> = Object.values(EnvRole)
export const isEnvRole = (value: unknown): value is EnvRole =>
  typeof value === "string" && (ENV_ROLES as readonly string[]).includes(value)

export const EnvAccessMode = {
  ReadOnly: "read_only",
  ReadWrite: "read_write",
} as const
export type EnvAccessMode = (typeof EnvAccessMode)[keyof typeof EnvAccessMode]
export const ENV_ACCESS_MODES: ReadonlyArray<EnvAccessMode> = Object.values(EnvAccessMode)
export const isEnvAccessMode = (value: unknown): value is EnvAccessMode =>
  typeof value === "string" && (ENV_ACCESS_MODES as readonly string[]).includes(value)

export const DiscoverySource = {
  FkAndPipeline: "fk+pipeline",
  FkOnly: "fk-only",
  PipelineOnly: "pipeline-only",
} as const
export type DiscoverySource = (typeof DiscoverySource)[keyof typeof DiscoverySource]
export const DISCOVERY_SOURCES: ReadonlyArray<DiscoverySource> = Object.values(DiscoverySource)
export const isDiscoverySource = (value: unknown): value is DiscoverySource =>
  typeof value === "string" && (DISCOVERY_SOURCES as readonly string[]).includes(value)

export const SyncOperationType = {
  Preview: "preview",
  Execute: "execute",
} as const
export type SyncOperationType = (typeof SyncOperationType)[keyof typeof SyncOperationType]
export const SYNC_OPERATION_TYPES: ReadonlyArray<SyncOperationType> = Object.values(SyncOperationType)
export const isSyncOperationType = (value: unknown): value is SyncOperationType =>
  typeof value === "string" && (SYNC_OPERATION_TYPES as readonly string[]).includes(value)

export const SyncPlanChangeType = {
  Unchanged: "unchanged",
  Updates: "updates",
  Deletes: "deletes",
  Inserts: "inserts",
} as const
export type SyncPlanChangeType = (typeof SyncPlanChangeType)[keyof typeof SyncPlanChangeType]
export const SYNC_PLAN_CHANGE_TYPES: ReadonlyArray<SyncPlanChangeType> = Object.values(SyncPlanChangeType)
export const isSyncPlanChangeType = (value: unknown): value is SyncPlanChangeType =>
  typeof value === "string" && (SYNC_PLAN_CHANGE_TYPES as readonly string[]).includes(value)

export const SyncRecipeDiscrepancyKind = {
  Leak: "leak",
  Implicit: "implicit",
  Drift: "drift",
} as const
export type SyncRecipeDiscrepancyKind =
  (typeof SyncRecipeDiscrepancyKind)[keyof typeof SyncRecipeDiscrepancyKind]
export const SYNC_RECIPE_DISCREPANCY_KINDS: ReadonlyArray<SyncRecipeDiscrepancyKind> =
  Object.values(SyncRecipeDiscrepancyKind)
export const isSyncRecipeDiscrepancyKind = (value: unknown): value is SyncRecipeDiscrepancyKind =>
  typeof value === "string" &&
  (SYNC_RECIPE_DISCREPANCY_KINDS as readonly string[]).includes(value)

export const ToolOutcomeSeverity = {
  Info: "info",
  Recoverable: "recoverable",
  Fatal: "fatal",
} as const
export type ToolOutcomeSeverity = (typeof ToolOutcomeSeverity)[keyof typeof ToolOutcomeSeverity]

export const ToolControlDirective = {
  Continue: "continue",
  RetryAfterInspection: "retry_after_inspection",
  AbortRound: "abort_round",
  AbortLoop: "abort_loop",
} as const
export type ToolControlDirective = (typeof ToolControlDirective)[keyof typeof ToolControlDirective]

export interface ToolResultArtifactState {
  readonly path: string
  readonly preservedExisting?: boolean
  readonly requiresReadBeforeMutation?: boolean
}

export interface ToolResultEnvelope {
  readonly ok: boolean
  readonly summary: string
  readonly severity?: ToolOutcomeSeverity
  readonly directive?: ToolControlDirective
  readonly errorCode?: string
  readonly retryable?: boolean
  readonly details?: readonly string[]
  readonly artifacts?: readonly ToolResultArtifactState[]
  readonly data?: Record<string, unknown>
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string | ToolResultEnvelope>
}

export interface MssqlEntry {
  config: sql.config
  pool: sql.ConnectionPool | null
  writeEnabled: boolean
  knowledge: string | null
}

export interface MssqlHost {
  databases: Map<string, MssqlEntry>
  defaultConnection: { value: string | null }
}

export interface SyncHost {
  eventSink: SyncEventSink
  runSink: SyncRunSink
  recipes: { bundle: SyncRecipeBundle | null; loadedFromPath: string | null }
  environments: Map<string, SyncEnvironment>
  plans: { diskRoot: string | null; memCache: Map<string, SyncPlan> }
  dbProjectRoot: string | null
}

export interface AgentHost {
  mssql: MssqlHost
  sync: SyncHost
}

export function getMssqlConfig(host: AgentHost): Array<{ name: string; server: string; database: string; writeEnabled: boolean; knowledge: string | null }> {
  return Array.from(host.mssql.databases.entries()).map(([name, entry]) => ({
    name,
    server: entry.config.server!,
    database: entry.config.database!,
    writeEnabled: entry.writeEnabled,
    knowledge: entry.knowledge,
  }))
}

export async function getPool(host: AgentHost, name = "default"): Promise<{ pool: sql.ConnectionPool; entry: MssqlEntry }> {
  const mssql = host.mssql
  const resolvedName = mssql.databases.has(name)
    ? name
    : (name === "default" && mssql.databases.size > 0)
      ? (mssql.defaultConnection.value && mssql.databases.has(mssql.defaultConnection.value)
          ? mssql.defaultConnection.value
          : mssql.databases.keys().next().value as string)
      : name
  const entry = mssql.databases.get(resolvedName)
  if (!entry) {
    const available = Array.from(mssql.databases.keys()).join(", ") || "none"
    throw new Error(
      `MSSQL connection "${name}" not configured. Available: ${available}.`,
    )
  }
  if (entry.pool?.connected) return { pool: entry.pool, entry }
  if (entry.pool) {
    try { await entry.pool.close() } catch { }
  }
  entry.pool = new sql.ConnectionPool(entry.config)
  await entry.pool.connect()
  return { pool: entry.pool, entry }
}
