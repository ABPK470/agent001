/**
 * host/host.ts — AgentHost + RunContext.
 *
 * The doctrine, in two type declarations:
 *
 *   AgentHost   — every adapter the agent needs, wired once at boot.
 *                 Lives for the whole process. Pass it down by argument.
 *
 *   RunContext  — everything that changes between runs (signal, trace,
 *                 per-run memory writer, sync op context). Threaded as
 *                 a parameter to tool handlers. Never module-global.
 *
 * Nothing here is a class. Nothing here is mutable. The host record is
 * built once by `configureAgent()` and never re-bound. The run context
 * is built once per `runAgent()` call and never re-bound. Both are
 * plain readonly records.
 */

import type {
  FreezeWindowDefinition,
  PublishedSyncDefinitionRegistry,
  SyncEnvironment,
  SyncEventSink,
  SyncPlan,
  SyncRunSink
} from "@mia/sync"
import type {
  ConnectorInfo,
  MoveSummary,
  ReadSpec,
  Transform,
  WriteSpec,
} from "@mia/shared-types"
import type {
  AttachmentStore,
  MssqlEntry,
  MssqlPoolProvider,
  ShellClient,
  TableVerdictsReader,
  ToolKnowledgeStore,
  UserInputReader
} from "../../ports/ports.js"
import type { CatalogGraph } from "../../tools/index.js"

// ── AgentHost — wired once at boot ───────────────────────────────

export interface MssqlHost {
  /** Connection registry — populated at boot via `configureAgent(...)`. */
  readonly databases: Map<string, MssqlEntry>
  /** Override which named connection serves `connection: "default"` (mutable container). */
  readonly defaultConnection: { value: string | null }
  /**
   * Live connector-keyed pool provider — the source of truth for MSSQL pools.
   * Sync environments resolve their pool through `connectorId` (the real FK).
   * Optional: only sync-capable hosts provide it; agent-only hosts (direct
   * MSSQL tools/catalog) still use `databases`/`defaultConnection` until
   * they are migrated onto this provider. Sync pool resolution throws
   * loudly if this is absent — there is no silent fallback.
   */
  readonly pools?: MssqlPoolProvider
}

export interface FilesystemHost {
  /** Sandbox root — all file paths must resolve under this. */
  readonly basePath: string
}

export interface SearchFilesHost {
  readonly basePath: string
  readonly excludeDirs: ReadonlySet<string>
}

export interface ShellHost {
  readonly mode: "host" | "sandbox" | "disabled"
  readonly cwd: string
  readonly sandboxStrict: boolean
  readonly client: ShellClient | null
}

export interface CatalogHost {
  /** Per-connection catalog graphs — expensive caches. */
  readonly instances: Map<string, CatalogGraph>
  /** Default disk cache path — mutable container so `buildCatalog` can remember the most recent path. */
  readonly defaultCachePath: { value: string | undefined }
}

export interface SyncEventsHost {
  sink: SyncEventSink
}

export interface SyncRunsHost {
  sink: SyncRunSink
  /** Run/agent owner UPN for sync persistence when preview input omits `userUpn`. */
  actorUpn: string | null
}

export interface SyncGovernanceHost {
  freezeWindowsReader: () => readonly FreezeWindowDefinition[]
}

export interface SyncEnvironmentRegistryHost {
  items: Map<string, SyncEnvironment>
}

export interface SyncPlansHost {
  /** Plan disk root + in-memory cache. Both fields mutable at runtime. */
  diskRoot: string | null
  memCache: Map<string, SyncPlan>
}

export interface SyncProjectHost {
  dbProjectRoot: string | null
  publishedDefinitions: PublishedSyncDefinitionRegistry
}

/** Mutable container for sync state. This is the host-owned sync surface. */
export interface SyncHost {
  events: SyncEventsHost
  runs: SyncRunsHost
  governance: SyncGovernanceHost
  environments: SyncEnvironmentRegistryHost
  plans: SyncPlansHost
  project: SyncProjectHost
}

export interface TenantHost {
  readonly id: string | null
  readonly displayName: string | null
  readonly featureFlags: ReadonlyMap<string, boolean>
}

/**
 * Opaque port for the connector-adapter Bridge engine. The server
 * builds this from persisted connectors (see @mia/connectors `buildConnectorPort`)
 * and binds it AFTER `configureAgent` via the mutable `port` container (the
 * port needs the host's connection pools, which only exist once the host is
 * built — so the host holds a late-bound slot, mirroring `defaultConnection`).
 * CLI/tests leave `port.value` null. The agent never imports adapter drivers.
 */
export interface ConnectorPort {
  moveData(
    source: { connectorId: string; spec: ReadSpec },
    target: { connectorId: string; spec: WriteSpec; stopOnError?: boolean },
    options?: { transform?: Transform; signal?: AbortSignal },
  ): Promise<MoveSummary>
  /** Read up to `limit` rows from the source, apply the transform, return them (no write). */
  previewMove(
    source: { connectorId: string; spec: ReadSpec },
    options?: { transform?: Transform; limit?: number },
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }>
  listAdapters(): ConnectorInfo[]
}

/** Sink for Bridge lifecycle events (preview / run) — wired to SSE + event_log on the server. */
export type BridgeEventSink = (event: {
  type: import("@mia/shared-enums").EventType
  data: Record<string, unknown>
}) => void

export interface ConnectorsHost {
  /** Late-bound: the server fills this after `configureAgent`. */
  readonly port: { value: ConnectorPort | null }
  /** Mutable sink — server swaps in broadcast; CLI/tests leave the noop. */
  readonly events: { sink: BridgeEventSink }
}

/**
 * Everything the agent needs from the world, in one record.
 *
 * Built once by {@link configureAgent} at process startup. Passed by
 * argument from the entrypoint down to whatever needs it. Never stored
 * in a module global, never accessed through a thread-local lookup.
 *
 * A field being `null` is a deliberate signal: that capability is not
 * wired in this deployment (CLI / tests). Tools that depend on it must
 * surface a friendly error.
 */
export interface AgentHost {
  readonly workspaceRoot: string
  readonly mssql: MssqlHost
  readonly filesystem: FilesystemHost
  readonly searchFiles: SearchFilesHost
  readonly shell: ShellHost
  readonly userInput: UserInputReader | null
  readonly attachments: AttachmentStore | null
  readonly toolKnowledge: ToolKnowledgeStore | null
  readonly tableVerdicts: TableVerdictsReader | null
  readonly catalog: CatalogHost
  readonly sync: SyncHost
  readonly tenant: TenantHost
  readonly connectors: ConnectorsHost
}

/**
 * Narrow host slice for MSSQL connection + catalog lookup.
 * Prefer this over fabricating a partial {@link AgentHost}.
 */
export type MssqlCatalogHost = Pick<AgentHost, "mssql" | "catalog">

// ── RunContext — built per run, passed as a parameter ────────────

/**
 * Per-run memory writer. The server binds a concrete implementation per
 * agent run so durable lessons (validator auto-notes, tool-execution
 * findings) route to `ingestAgentNote`. Null when the agent runs without
 * a server (CLI / tests) — lessons are dropped, the doctrine block fires
 * unchanged.
 */
export interface RunMemoryWriter {
  writeNote(payload: { subject: string; claim: string; evidence?: string; category?: string }): void
}

/** Causal trace for a tool call — opaque to most callers. */
export interface ToolTraceContext {
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly parentCallId: string | null
}

/**
 * Policy-decision context for governance hooks (current step, current
 * delegation depth, etc.). Read-only.
 */
export interface PolicyContext {
  readonly runId: string
  readonly currentStep: string | null
  readonly delegationDepth: number
}

/** Context for an in-flight sync operation (which plan, which entity). */
export interface SyncOpContext {
  readonly planId: string
  readonly entityType: string | null
  readonly environment: string | null
}

/**
 * Everything that varies between agent runs.
 *
 * Built once by `runAgent({ ... })` at run start, threaded to every tool
 * handler as a parameter. No `AsyncLocalStorage`, no setters. When a tool
 * needs a per-run value it accepts a `RunContext` argument.
 */
export interface RunContext {
  /** Per-run abort signal. Tools should pass this to long IO. */
  signal: AbortSignal | null
  /** Per-run memory writer; null when no server is bound. */
  readonly memory: RunMemoryWriter | null
  /** Active tool-call trace, if inside a tool handler. */
  readonly trace: ToolTraceContext | null
  /** Active policy context, if a policy decision is being made. */
  readonly policy: PolicyContext | null
  /** Active sync-op context, if executing a sync runbook step. */
  readonly syncOp: SyncOpContext | null
  /**
   * Per-run set of qualified table names that `profile_data` has been
   * called on. Read by the MSSQL validator to soft-warn on big-view
   * queries with no preceding profile. Mutated by `profile_data`.
   */
  readonly mssqlProfileCalls: Set<string>
  /**
   * Tables whose columns are verified for this run — populated by
   * search_catalog(table=), explore_mssql_schema(table=), profile_data,
   * and seeded from known_objects / goal anchors at run start.
   * query_mssql blocks SQL referencing catalog tables not in this set.
   */
  readonly mssqlVerifiedTables: Set<string>
}
