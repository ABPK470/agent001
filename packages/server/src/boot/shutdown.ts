import { closeMssqlPool, type AgentHost } from "@mia/agent"
import type { FastifyInstance } from "fastify"
import { stopScheduler } from "../api/proposer/index.js"
import type { AgentOrchestrator } from "../api/runs/orchestrator.js"
import type { DockerSandbox } from "../infra/sandbox/index.js"
import type { MessageQueue } from "../infra/queue/channels/index.js"

export interface GracefulShutdownDeps {
  readonly app: FastifyInstance
  readonly orchestrator: AgentOrchestrator
  readonly messageQueue: MessageQueue
  readonly bootHost: AgentHost
  readonly sandbox: DockerSandbox
  readonly unsubscribeNotifications: () => void
}

let shuttingDown = false

export function registerGracefulShutdown(deps: GracefulShutdownDeps): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] ${signal} — stopping services`)

    deps.orchestrator.beginShutdown()

    try {
      await deps.app.close()
    } catch {
      /* already closed */
    }

    await stopScheduler(60_000)
    deps.messageQueue.stop()
    deps.unsubscribeNotifications()
    await deps.orchestrator.drainRuns(60_000)
    await closeMssqlPool(deps.bootHost)
    await deps.sandbox.cleanup()

    console.log("[shutdown] complete")
    process.exit(0)
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal)
    })
  }
}
