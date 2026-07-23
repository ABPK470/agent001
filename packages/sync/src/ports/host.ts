import type { MssqlConfig, MssqlConnectionPool } from "../internal/mssql-types.js"
import type { SyncPlan } from "../domain/plan.js"
import type { ToolControlDirective, ToolOutcomeSeverity } from "../domain/enums.js"
import type { SyncEnvironment } from "../domain/environments.js"
import type { PublishedSyncDefinitionRegistry } from "../domain/published-definition-registry.js"
import type { SyncPublishReadinessPort } from "../domain/publish-readiness.js"
import type { SyncEventSink } from "./events.js"
import type { SyncRunSink } from "./run-sink.js"

export type { SyncPublishReadinessPort }

/** Live connector-keyed pool handle resolved through {@link MssqlPoolProvider}. */
export interface MssqlConnectorPool {
  connectorId: string
  pool: MssqlConnectionPool
  config: MssqlConfig
  knowledge: string | null
}

/** Resolve MSSQL pools by connector id or name (live read). */
export interface MssqlPoolProvider {
  get(connectorId: string): Promise<MssqlConnectorPool>
  getByName(name: string): Promise<MssqlConnectorPool>
  configOf(connectorId: string): MssqlConfig | undefined
  list(): readonly { id: string; name: string }[]
  invalidate(connectorId: string): void
}

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

/** Metadata the runtime and LLM need to advertise a tool without binding execution. */
export interface ToolMetadata {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** Fully bound executable tool — same shape as {@link Tool}. */
export type ExecutableTool = Tool

export interface MssqlEntry {
  config: MssqlConfig
  pool: MssqlConnectionPool | null
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
  /** Shell wires tip-vs-published; tests use {@link ALWAYS_PUBLISH_READY}. */
  publishReadiness: SyncPublishReadinessPort
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
