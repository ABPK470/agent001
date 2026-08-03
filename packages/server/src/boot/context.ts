import { configureAgent, type AgentHost } from "@mia/agent"
import {
  configurePlanStore,
  createDbPublishedSyncDefinitionRegistry,
  listFreezeWindows,
} from "@mia/sync"
import { seedDefaultPoliciesIfMissing } from "../api/policies/service/policy-seeder.js"
import { refreshFreezeWindowRegistry } from "../infra/persistence/index.js"
import type { BootHostDeps } from "../ports/orchestration.js"
import {
  createServerWorkspaceRef,
  resolveServerWorkspace,
  type ServerWorkspaceRef
} from "./server-workspace.js"
import { resolveSyncPlansDir } from "../infra/persistence/server-data-dir.js"
import { entityNeedsRepublishCached, refreshEntityNeedsRepublishCache } from "../api/sync/service/definitions.js"

import { loadPublishedBundleFromSqliteCached } from "./published-sync-bundle.js"
import { projectRoot } from "./paths.js"
import { configureSandbox, type SandboxRuntime } from "../adapters/agent/shell.js"
import {
  createBridgeEventSink,
  createSyncEventSink,
  createSyncRunSink,
} from "../adapters/sync/sinks.js"
import { loadBootSyncEnvironments } from "./sync-environments.js"
import { loadPersistedConnectors } from "../adapters/connectors/live-connectors.js"
import { mssqlConfigsFromConnectors } from "../adapters/connectors/mssql-from-connectors.js"
import { createMssqlPoolProvider } from "../adapters/connectors/mssql-pool-provider.js"
import { createPostgresPoolProvider } from "../adapters/connectors/postgres-pool-provider.js"
import { createWarehousePoolProvider } from "../adapters/connectors/warehouse-pool-provider.js"
import { buildMovementPort } from "../adapters/connectors/movement-port.js"
import {
  registerOperation,
  unregisterOperation,
} from "../infra/operations/cancel-registry.js"

export interface ServerContext {
  readonly projectRoot: string
  readonly workspace: ServerWorkspaceRef
  readonly sandbox: SandboxRuntime
  readonly bootHost: AgentHost
  readonly mssqlSummary: string
  readonly syncEnvironments: Awaited<ReturnType<typeof loadBootSyncEnvironments>>
}

function logSyncEnvironments(syncEnvironments: ServerContext["syncEnvironments"]): void {
  if (syncEnvironments.source === "db") {
    console.log(`ABI environments (from persisted DB): ${syncEnvironments.summary}`)
  } else if (syncEnvironments.source === "file") {
    console.log(
      `ABI environments seeded from deploy/sync/sync-environments.json: ${syncEnvironments.summary}`
    )
  } else if (syncEnvironments.source === "connections") {
    console.log(`ABI environments seeded from connector names: ${syncEnvironments.summary}`)
  }
}

export async function createServerContext(): Promise<ServerContext> {
  const workspace = createServerWorkspaceRef(resolveServerWorkspace())
  const sandbox = await configureSandbox(() => workspace.get())

  // Connectors DB is the source of truth for SQL Server (and other) connections.
  // Empty DB seeds once from deploy/connectors/connectors.json when present.
  const connectors = await loadPersistedConnectors(projectRoot)
  const mssqlConfigs = mssqlConfigsFromConnectors(connectors.connectors, projectRoot)
  const mssqlDefaultConnectionName = process.env["MSSQL_DEFAULT_CONNECTION"] ?? null

  const syncEnvironments = await loadBootSyncEnvironments(projectRoot, mssqlConfigs)
  await refreshFreezeWindowRegistry()
  await refreshEntityNeedsRepublishCache(projectRoot)
  const syncEventSink = createSyncEventSink()
  const syncRunSink = createSyncRunSink()

  // Live, connector-keyed pool providers — Sync envs resolve through connectorId.
  const mssqlPools = createMssqlPoolProvider(projectRoot)
  const postgresPools = createPostgresPoolProvider()
  const warehousePools = createWarehousePoolProvider({ mssql: mssqlPools, postgres: postgresPools })

  const catalogInstances: AgentHost["catalog"]["instances"] = new Map()
  const catalogDefaultCachePath: AgentHost["catalog"]["defaultCachePath"] = { value: undefined }
  const bootHost = configureAgent({
    mssqlConfigs,
    mssqlDefaultConnectionName,
    mssqlPools,
    catalogInstances,
    catalogDefaultCachePath,
    sync: {
      events: { sink: syncEventSink },
      runs: { sink: syncRunSink, actorUpn: null },
      environments: { items: syncEnvironments.environments },
      project: {
        dbProjectRoot: projectRoot,
        publishedDefinitions: createDbPublishedSyncDefinitionRegistry(loadPublishedBundleFromSqliteCached),
        publishReadiness: {
          entityNeedsRepublish: entityNeedsRepublishCached,
        },
      },
      governance: { freezeWindowsReader: listFreezeWindows },
      warehousePools,
    }
  })

  // Late-bind the connectors port: it needs the boot host's connection pools,
  // so it is built after configureAgent and stored in the mutable slot. The
  // port re-reads persisted connectors live from the DB on each call, so
  // runtime create/enable/disable/delete is reflected without a restart.
  bootHost.connectors.port.value = buildMovementPort(bootHost, { postgresPools })
  bootHost.connectors.events.sink = createBridgeEventSink()
  bootHost.connectors.operations.value = {
    register: registerOperation,
    unregister: unregisterOperation,
  }

  const mssqlSummary =
    mssqlConfigs.length > 0
      ? mssqlConfigs.map((c) => `${c.name}(${c.server}/${c.database ?? "master"})`).join(", ")
      : "not configured"

  logSyncEnvironments(syncEnvironments)
  if (connectors.seeded && connectors.source === "file") {
    console.log(`Connectors seeded from deploy/connectors/connectors.json: ${connectors.summary}`)
  } else if (connectors.source === "db") {
    console.log(`Connectors (from persisted DB): ${connectors.summary}`)
  } else {
    console.log("Connectors: none — add from platform menu → Connectors")
  }
  console.log(`MSSQL databases (from connectors): ${mssqlSummary}`)
  await seedDefaultPoliciesIfMissing(projectRoot)
  configurePlanStore(bootHost, resolveSyncPlansDir())

  return {
    projectRoot,
    workspace,
    sandbox,
    bootHost,
    mssqlSummary,
    syncEnvironments
  }
}

export function buildBootHostDeps(ctx: ServerContext): BootHostDeps {
  const { bootHost, sandbox } = ctx
  return {
    shell: {
      mode: sandbox.shellClient ? "sandbox" : "host",
      client: sandbox.shellClient,
      sandboxStrict: sandbox.shellSandboxStrict
    },
    mssql: {
      databases: bootHost.mssql.databases,
      defaultConnection: bootHost.mssql.defaultConnection,
      pools: bootHost.mssql.pools
    },
    catalog: {
      instances: bootHost.catalog.instances,
      defaultCachePath: bootHost.catalog.defaultCachePath
    },
    sync: {
      events: bootHost.sync.events,
      runs: bootHost.sync.runs,
      governance: bootHost.sync.governance,
      environments: bootHost.sync.environments,
      plans: bootHost.sync.plans,
      project: bootHost.sync.project
    },
    connectors: {
      port: bootHost.connectors.port,
      events: bootHost.connectors.events,
      operations: bootHost.connectors.operations,
    }
  }
}
