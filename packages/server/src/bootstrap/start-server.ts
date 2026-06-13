/**
 * Server startup — ordered wiring from persistence through HTTP listen and shutdown.
 */

import { bootstrapAdminFromEnv } from "../features/auth/index.js"
import { openDatabase, runDatabaseMaintenance } from "../platform/persistence/index.js"
import { buildApp } from "../app/build-app.js"
import { printStartupBanner } from "./banner.js"
import { createServerContext } from "./context.js"
import { buildLlmAndCatalog } from "./llm.js"
import { initMessaging } from "./messaging.js"
import { createOrchestrator } from "./orchestrator-factory.js"
import { listenHost, listenPort, resolveUiDist } from "./paths.js"
import { createServerWorkspaceRef } from "./server-workspace.js"
import { registerGracefulShutdown } from "./shutdown.js"
import { startSidecars } from "./sidecars.js"

function recoverStaleRuns(orchestrator: ReturnType<typeof createOrchestrator>): void {
  const recovery = orchestrator.recoverStaleRuns()
  if (recovery.failed.length > 0) {
    console.log(`Recovered ${recovery.recovered.length} stale runs, ${recovery.failed.length} marked failed`)
  }
}

export async function startServer(): Promise<void> {
  // 1. Persistence — open SQLite, then one-time boot hygiene
  openDatabase()
  runDatabaseMaintenance()
  bootstrapAdminFromEnv()

  // 2. Platform runtime (sandbox, MSSQL, sync, boot host)
  const ctx = await createServerContext()

  // 3. LLM + catalog
  const llm = await buildLlmAndCatalog(ctx.bootHost, ctx.mssqlSummary)

  // 4. Background services (evidence signer, proposer scheduler, notifications)
  const sidecars = startSidecars({ bootHost: ctx.bootHost, llm })

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
    evidenceStorageRoot: sidecars.evidenceStorageRoot,
    evidenceSigner: sidecars.evidenceSigner,
    llmPortHolder: sidecars.llmPortHolder,
    bootHost: ctx.bootHost
  })

  // 7. Listen
  await app.listen({ port: listenPort, host: listenHost })
  recoverStaleRuns(orchestrator)
  printStartupBanner({
    mssqlSummary: ctx.mssqlSummary,
    channelConfigs: messaging.channelConfigs,
    uiDist
  })

  // 8. Graceful shutdown
  registerGracefulShutdown({
    app,
    orchestrator,
    messageQueue: messaging.messageQueue,
    bootHost: ctx.bootHost,
    sandbox: ctx.sandbox.sandbox,
    unsubscribeNotifications: sidecars.unsubscribeNotifications
  })
}
