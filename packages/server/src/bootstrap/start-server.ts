/**
 * Server bootstrap — wires persistence, platform runtime, HTTP, and shutdown.
 */

import { buildApp } from "../app/build-app.js"
import { printStartupBanner } from "./banner.js"
import { createServerContext } from "./context.js"
import { initDatabase } from "./database.js"
import { buildLlmAndCatalog } from "./llm.js"
import { initMessaging } from "./messaging.js"
import { createOrchestrator } from "./orchestrator-factory.js"
import { listenHost, listenPort, resolveUiDist } from "./paths.js"
import { registerGracefulShutdown } from "./shutdown.js"
import { startSidecars } from "./sidecars.js"
import { bindWorkspace } from "./workspace-binding.js"

function recoverStaleRuns(orchestrator: ReturnType<typeof createOrchestrator>): void {
  const recovery = orchestrator.recoverStaleRuns()
  if (recovery.failed.length > 0) {
    console.log(`Recovered ${recovery.recovered.length} stale runs, ${recovery.failed.length} marked failed`)
  }
}

export async function startServer(): Promise<void> {
  initDatabase()

  const ctx = await createServerContext()
  const llm = await buildLlmAndCatalog(ctx.bootHost, ctx.mssqlSummary)
  const sidecars = startSidecars({ bootHost: ctx.bootHost, llm })

  const orchestrator = createOrchestrator(ctx, llm)
  const workspace = bindWorkspace(ctx, orchestrator)
  const messaging = initMessaging(orchestrator)

  const app = await buildApp({
    projectRoot: ctx.projectRoot,
    orchestrator,
    messageQueue: messaging.messageQueue,
    messageRouter: messaging.messageRouter,
    uiDist: resolveUiDist(),
    workspace,
    evidenceStorageRoot: sidecars.evidenceStorageRoot,
    evidenceSigner: sidecars.evidenceSigner,
    llmPortHolder: sidecars.llmPortHolder,
    bootHost: ctx.bootHost
  })

  await app.listen({ port: listenPort, host: listenHost })
  recoverStaleRuns(orchestrator)
  printStartupBanner({
    mssqlSummary: ctx.mssqlSummary,
    channelConfigs: messaging.channelConfigs,
    uiDist: resolveUiDist()
  })

  registerGracefulShutdown({
    app,
    orchestrator,
    messageQueue: messaging.messageQueue,
    bootHost: ctx.bootHost,
    sandbox: ctx.sandbox.sandbox,
    unsubscribeNotifications: sidecars.unsubscribeNotifications
  })
}
