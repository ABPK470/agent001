import type sql from "mssql"
import type { SyncPlan } from "../application/shell/plan-store.js"
import type { ToolControlDirective, ToolOutcomeSeverity } from "../domain/enums.js"
import type { SyncEnvironment } from "../domain/environments.js"
import type { PublishedSyncDefinitionRegistry } from "../domain/published-definition-registry.js"
import type { SyncEventSink } from "./events.js"
import type { SyncRunSink } from "./run-sink.js"

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

export interface MssqlAccessHost {
  mssql: MssqlHost
}

export interface SyncHost {
  eventSink: SyncEventSink
  runSink: SyncRunSink
  environments: Map<string, SyncEnvironment>
  plans: { diskRoot: string | null; memCache: Map<string, SyncPlan> }
  dbProjectRoot: string | null
  publishedDefinitions: PublishedSyncDefinitionRegistry
}

export interface SyncEventHost {
  sync: Pick<SyncHost, "eventSink">
}

export interface SyncRunHost {
  sync: Pick<SyncHost, "runSink">
}

export interface SyncEnvironmentRegistryHost {
  sync: Pick<SyncHost, "environments">
}

export interface SyncPlanStoreHost {
  sync: Pick<SyncHost, "plans" | "runSink">
}

export interface SyncProjectRootHost {
  sync: Pick<SyncHost, "dbProjectRoot" | "publishedDefinitions">
}

export interface SyncStateHost {
  sync: SyncHost
}

export interface SyncRuntimeHost extends MssqlAccessHost, SyncStateHost {
}