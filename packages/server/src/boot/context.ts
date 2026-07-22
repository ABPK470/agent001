import { configureAgent, type AgentHost } from "@mia/agent"
import { configurePlanStore, createDbPublishedSyncDefinitionRegistry } from "@mia/sync"
import { seedDefaultPoliciesIfMissing } from "../api/policies/service/policy-seeder.js"
import { setupMssql } from "../infra/mssql/setup.js"
import { listFreezeWindowDefinitionsForTenant } from "../infra/persistence/index.js"
import type { BootHostDeps } from "../ports/orchestration.js"
import {
  createServerWorkspaceRef,
  resolveServerWorkspace,
  type ServerWorkspaceRef
} from "./server-workspace.js"
import { resolveSyncPlansDir } from "../infra/persistence/server-data-dir.js"
import { entityNeedsRepublish } from "../api/sync/service/definitions.js"

import { loadPublishedBundleFromSqlite } from "./published-sync-bundle.js"
import { projectRoot } from "./paths.js"
import { configureSandbox, type SandboxRuntime } from "../adapters/agent/shell.js"
import {
  createBridgeEventSink,
  createSyncEventSink,
  createSyncRunSink,
} from "../adapters/sync/sinks.js"
import { loadBootSyncEnvironments } from "./sync-environments.js"
import { loadPersistedConnectors } from "../api/connectors/state/live-connectors.js"
import { mssqlConfigsFromConnectors } from "../api/connectors/state/mssql-from-connectors.js"
import { createMssqlPoolProvider } from "../api/connectors/state/mssql-pool-provider.js"
import { buildMovementPort } from "../api/connectors/state/movement-port.js"

export interface ServerContext {
  readonly projectRoot: string
  readonly workspace: ServerWorkspaceRef
  readonly sandbox: SandboxRuntime
  readonly bootHost: AgentHost
  readonly mssqlSummary: string
  readonly syncEnvironments: ReturnType<typeof loadBootSyncEnvironments>
}

function logSyncEnvironments(syncEnvironments: ServerContext["syncEnvironments"]): void {
  if (syncEnvironments.source === "db") {
    console.log(`ABI environments (from persisted DB): ${syncEnvironments.summary}`)
  } else if (syncEnvironments.source === "file") {
    console.log(
      `ABI environments seeded from deploy/sync/sync-environments.json: ${syncEnvironments.summary}`
    )
  } else if (syncEnvironments.source === "mssql") {
    console.log(`ABI environments seeded from MSSQL_DATABASES: ${syncEnvironments.summary}`)
  }
}

export async function createServerContext(): Promise<ServerContext> {
  const workspace = createServerWorkspaceRef(resolveServerWorkspace())
  const sandbox = await configureSandbox(() => workspace.get())

  // Legacy `.env` MSSQL vars are consulted only as a one-time seed bridge so
  // existing deployments populate the connectors DB on first boot. The live
  // source of truth for `host.mssql.databases` is the persisted connectors DB.
  const legacyMssqlSetup = setupMssql(projectRoot)
  const connectors = loadPersistedConnectors(projectRoot, legacyMssqlSetup.configs)
  const mssqlConfigs = mssqlConfigsFromConnectors(connectors.connectors, projectRoot)
  const mssqlDefaultConnectionName =
    process.env["MSSQL_DEFAULT_CONNECTION"] ?? legacyMssqlSetup.defaultConnectionName ?? null

  const syncEnvironments = loadBootSyncEnvironments(projectRoot, mssqlConfigs)
  const syncEventSink = createSyncEventSink()
  const syncRunSink = createSyncRunSink()

  // Live, connector-keyed MSSQL pool provider — the single source of truth for
  // pools. Sync environments resolve their pool through `connectorId`.
  const mssqlPools = createMssqlPoolProvider(projectRoot)

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
        publishedDefinitions: createDbPublishedSyncDefinitionRegistry(loadPublishedBundleFromSqlite),
        publishReadiness: {
          entityNeedsRepublish: (entityId) => entityNeedsRepublish(projectRoot, entityId),
        },
      },
      governance: { freezeWindowsReader: () => listFreezeWindowDefinitionsForTenant() }
    }
  })

  // Late-bind the connectors port: it needs the boot host's connection pools,
  // so it is built after configureAgent and stored in the mutable slot. The
  // port re-reads persisted connectors live from the DB on each call, so
  // runtime create/enable/disable/delete is reflected without a restart.
  bootHost.connectors.port.value = buildMovementPort(bootHost)
  bootHost.connectors.events.sink = createBridgeEventSink()

  const mssqlSummary =
    mssqlConfigs.length > 0
      ? mssqlConfigs.map((c) => `${c.name}(${c.server}/${c.database ?? "master"})`).join(", ")
      : "not configured"

  logSyncEnvironments(syncEnvironments)
  if (connectors.seeded) {
    if (connectors.source === "file") {
      console.log(`Connectors seeded from deploy/connectors/connectors.json: ${connectors.summary}`)
    } else if (connectors.source === "mssql") {
      console.log(`Connectors seeded from MSSQL_DATABASES: ${connectors.summary}`)
    }
  } else {
    console.log(`Connectors (from persisted DB): ${connectors.summary}`)
  }
  console.log(`MSSQL databases (from connectors): ${mssqlSummary}`)
  seedDefaultPoliciesIfMissing(projectRoot)
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
    }
  }
}
