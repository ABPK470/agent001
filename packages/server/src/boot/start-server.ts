/**
 * Server startup — ordered wiring from persistence through HTTP listen and shutdown.
 */

import {
  formatTenantConfigBootSummary,
  isDefaultTenantConfig,
  loadTenantConfigFromEnv,
  resolveTenantConfigPath
} from "@mia/agent"
import { buildApp } from "../http/build-app.js"
import { loadPublishedSyncVocabularyAtBoot } from "./published-sync-bundle.js"
import { bootstrapAdminFromEnv } from "../api/auth/index.js"
import { openDatabase, runDatabaseMaintenance, getLlmConfig, getDbPath } from "../infra/persistence/index.js"
import { resolveServerDataDir } from "../infra/persistence/server-data-dir.js"
import { printStartupBanner } from "./banner.js"
import { createServerContext } from "./context.js"
import { buildLlmAndCatalog } from "./llm.js"
import { initMessaging } from "./messaging.js"
import { createOrchestrator } from "./orchestrator-factory.js"
import { listenHost, listenPort, projectRoot, resolveUiDist } from "./paths.js"
import { createServerWorkspaceRef } from "./server-workspace.js"
import { registerGracefulShutdown } from "./shutdown.js"
import { startSyncPlatform } from "./sync-platform.js"
import { recoverStaleProposerRuns } from "../api/proposer/runtime/recovery.js"

function recoverStaleRuns(orchestrator: ReturnType<typeof createOrchestrator>): void {
  const recovery = orchestrator.recoverStaleRuns()
  const proposerCancelled = recoverStaleProposerRuns()
  if (recovery.failed.length > 0 || proposerCancelled.length > 0) {
    console.log(
      `Recovered stale runs: ${recovery.failed.length} agent, ${proposerCancelled.length} proposer scan${proposerCancelled.length === 1 ? "" : "s"}`,
    )
  }
}

export async function startServer(): Promise<void> {
  // 1. Persistence — open SQLite, then one-time boot hygiene
  openDatabase()
  console.log(`Data directory: ${resolveServerDataDir()} (db: ${getDbPath()})`)
  runDatabaseMaintenance()
  bootstrapAdminFromEnv()

  // Tenant config — one JSON file per mia server install (see packages/agent/config/TENANT-CONFIG.md)
  const tenantPath = process.env.MIA_TENANT_CONFIG
  if (tenantPath) {
    const resolved = resolveTenantConfigPath(tenantPath, projectRoot)
    loadTenantConfigFromEnv(process.env, { baseDir: projectRoot })
    console.log(`Tenant config loaded: ${resolved} (${formatTenantConfigBootSummary()})`)
  } else if (isDefaultTenantConfig()) {
    console.warn(
      "Tenant config: built-in defaults (mirror off, no domain keywords). " +
        "Set MIA_TENANT_CONFIG=./deploy/tenant.json — see packages/agent/config/TENANT-CONFIG.md"
    )
  }

  // 2. Platform runtime (sandbox, MSSQL, sync, boot host)
  const ctx = await createServerContext()

  // Published bundle — written by Entity Registry publish, not setup or first boot
  loadPublishedSyncVocabularyAtBoot(projectRoot)

  // 3. LLM + catalog
  const llm = await buildLlmAndCatalog(ctx.bootHost, ctx.mssqlSummary)

  // 4. Sync platform (proposer, evidence, notifications)
  const syncPlatform = startSyncPlatform({ bootHost: ctx.bootHost, llm })

  // 5. Run orchestration + messaging
  const orchestrator = createOrchestrator(ctx, llm)
  const workspace = createServerWorkspaceRef(ctx.workspace.get(), (path) =>
    orchestrator.setWorkspace(path)
  )
  const messaging = initMessaging(orchestrator)

  // 6. HTTP application
  const uiDist = resolveUiDist()
  const app = await buildApp({
    projectRoot: ctx.projectRoot,
    orchestrator,
    messageQueue: messaging.messageQueue,
    messageRouter: messaging.messageRouter,
    uiDist,
    workspace,
    evidenceStorageRoot: syncPlatform.evidenceStorageRoot,
    evidenceSigner: syncPlatform.evidenceSigner,
    llmPortHolder: syncPlatform.llmPortHolder,
    bootHost: ctx.bootHost,
    mssqlSummary: ctx.mssqlSummary
  })

  // 7. Listen
  await app.listen({ port: listenPort, host: listenHost })
  recoverStaleRuns(orchestrator)
  printStartupBanner({
    mssqlSummary: ctx.mssqlSummary,
    channelConfigs: messaging.channelConfigs,
    uiDist,
    llmSummary: (() => {
      const cfg = getLlmConfig()
      return `${cfg.provider} / ${cfg.model}`
    })()
  })

  // 8. Graceful shutdown
  registerGracefulShutdown({
    app,
    orchestrator,
    messageQueue: messaging.messageQueue,
    bootHost: ctx.bootHost,
    sandbox: ctx.sandbox.sandbox,
    unsubscribeNotifications: syncPlatform.unsubscribeNotifications
  })
}
