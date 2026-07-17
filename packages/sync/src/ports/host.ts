import type sql from "mssql"
import type { MssqlPoolProvider } from "@mia/agent"
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
  /** Live connector-keyed pool provider — source of truth for sync env pools. Optional; sync resolution throws if absent. */
  pools?: MssqlPoolProvider
}

export interface MssqlAccessHost {
  mssql: MssqlHost
}

export interface SyncEventsHost {
  sink: SyncEventSink
}

export interface SyncRunsHost {
  sink: SyncRunSink
  actorUpn: string | null
}

export interface SyncEnvironmentRegistry {
  items: Map<string, SyncEnvironment>
}

export interface SyncPlanRegistry {
  diskRoot: string | null
  memCache: Map<string, SyncPlan>
}

export interface SyncProjectRegistry {
  dbProjectRoot: string | null
  publishedDefinitions: PublishedSyncDefinitionRegistry
}

export interface SyncHost {
  events: SyncEventsHost
  runs: SyncRunsHost
  environments: SyncEnvironmentRegistry
  plans: SyncPlanRegistry
  project: SyncProjectRegistry
}

export interface SyncEventHost {
  sync: Pick<SyncHost, "events">
}

export interface SyncRunHost {
  sync: Pick<SyncHost, "runs">
}

export interface SyncEnvironmentRegistryHost {
  sync: Pick<SyncHost, "environments">
}

export interface SyncPlanStoreHost {
  sync: Pick<SyncHost, "plans" | "runs">
}

export interface SyncProjectRootHost {
  sync: Pick<SyncHost, "project">
}

export interface SyncStateHost {
  sync: SyncHost
}

export interface SyncRuntimeHost extends MssqlAccessHost, SyncStateHost {}
