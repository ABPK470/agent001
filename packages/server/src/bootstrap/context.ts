import { configureAgent, type AgentHost } from "@mia/agent"
import { configurePlanStore } from "@mia/sync"
import { resolve } from "node:path"
import { serverBrowserCredentialProvider } from "../features/browser/runtime/credential-provider.js"
import { serverBrowserHandoffProvider } from "../features/browser/runtime/handoff-provider.js"
import { serverBrowserContextProvider } from "../features/browser/runtime/provider.js"
import { seedDefaultPoliciesIfMissing } from "../features/policies/application/policy-seeder.js"
import { setupMssql } from "../platform/mssql/setup.js"
import { listFreezeWindowDefinitionsForTenant } from "../platform/persistence/index.js"
import type { BootHostDeps } from "../ports/orchestration.js"
import {
  createServerWorkspaceRef,
  resolveServerWorkspace,
  type ServerWorkspaceRef
} from "./server-workspace.js"
import { projectRoot } from "./paths.js"
import { configureSandbox, type SandboxRuntime } from "./sandbox.js"
import { createSyncEventSink, createSyncRunSink, loadBootSyncEnvironments } from "./sync.js"

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

  const mssqlSetup = setupMssql(projectRoot)
  const syncEnvironments = loadBootSyncEnvironments(projectRoot, mssqlSetup.configs)
  const syncEventSink = createSyncEventSink()
  const syncRunSink = createSyncRunSink()

  const catalogInstances: AgentHost["catalog"]["instances"] = new Map()
  const catalogDefaultCachePath: AgentHost["catalog"]["defaultCachePath"] = { value: undefined }
  const bootHost = configureAgent({
    mssqlConfigs: mssqlSetup.configs,
    mssqlDefaultConnectionName: mssqlSetup.defaultConnectionName,
    catalogInstances,
    catalogDefaultCachePath,
    sync: {
      events: { sink: syncEventSink },
      runs: { sink: syncRunSink, actorUpn: null },
      environments: { items: syncEnvironments.environments },
      project: { dbProjectRoot: projectRoot },
      governance: { freezeWindowsReader: () => listFreezeWindowDefinitionsForTenant() }
    }
  })

  logSyncEnvironments(syncEnvironments)
  seedDefaultPoliciesIfMissing(bootHost)
  configurePlanStore(bootHost, resolve(projectRoot, "packages/server/data/sync-plans"))

  return {
    projectRoot,
    workspace,
    sandbox,
    bootHost,
    mssqlSummary: mssqlSetup.summary,
    syncEnvironments
  }
}

export function buildBootHostDeps(ctx: ServerContext): BootHostDeps {
  const { bootHost, sandbox } = ctx
  return {
    browser: {
      providers: {
        contextReader: serverBrowserContextProvider,
        credentialReader: serverBrowserCredentialProvider,
        handoffStore: serverBrowserHandoffProvider
      }
    },
    shell: {
      mode: sandbox.shellClient ? "sandbox" : "host",
      client: sandbox.shellClient,
      sandboxStrict: sandbox.shellSandboxStrict
    },
    browserCheck: {
      mode: sandbox.browserCheckMode,
      client: sandbox.browserCheckClient
    },
    mssql: {
      databases: bootHost.mssql.databases,
      defaultConnection: bootHost.mssql.defaultConnection
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
    }
  }
}
