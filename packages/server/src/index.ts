/**
 * Server entry point — wires everything together.
 *
 * Starts Fastify with:
 *   - CORS (for dev: UI on different port)
 *   - WebSocket (real-time events)
 *   - Static file serving (production: serves built UI)
 *   - REST API routes (runs, layouts)
 *   - Agent orchestrator (starts/stops/resumes runs)
 *   - Copilot LLM client (GitHub Models API)
 */

import { config } from "dotenv"
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"

// Load .env from repo root (npm workspaces sets CWD to packages/server)
config({ path: resolve(import.meta.dirname, "../../../.env") })

import {
    setBasePath,
    setShellCwd,
} from "@agent001/agent"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import Fastify from "fastify"
import {
    MessageQueue,
    MessageRouter,
    MessengerChannel,
    SqliteConversationStore,
    SqliteQueueStore,
    WhatsAppChannel,
    listChannelConfigs,
    migrateChannels,
} from "./channels/index.js"
import { clearTransactionalData, getDb, getLlmConfig, migrateNotifications } from "./db.js"
import { buildLlmClient } from "./llm/registry.js"
import { AgentOrchestrator } from "./orchestrator.js"
import { registerAgentRoutes } from "./routes/agents.js"
import { registerLayoutRoutes } from "./routes/layouts.js"
import { registerLlmRoutes } from "./routes/llm.js"
import { registerMemoryRoutes } from "./routes/memory.js"
import { registerNotificationRoutes } from "./routes/notifications.js"
import { registerPolicyRoutes } from "./routes/policies.js"
import { registerRunRoutes } from "./routes/runs.js"
import { registerUsageRoutes } from "./routes/usage.js"
import { registerWebhookRoutes } from "./routes/webhooks.js"
import { addClient } from "./ws.js"

const PORT = Number(process.env["PORT"] ?? 3001)
const HOST = process.env["HOST"] ?? "0.0.0.0"

async function main() {
  // Initialize database
  getDb()
  migrateChannels()
  migrateNotifications()
  console.log("📦 Database initialized (~/.agent001/agent001.db)")

  // Set agent workspace — all file/shell operations are scoped here.
  // Default to monorepo root (walk up from server package to find .git),
  // falling back to cwd if not in a monorepo.
  function findRepoRoot(from: string): string {
    let dir = resolve(from)
    while (dir !== resolve(dir, "..")) {
      if (existsSync(resolve(dir, ".git"))) return dir
      dir = resolve(dir, "..")
    }
    return from
  }
  let currentWorkspace = resolve(process.env["AGENT_WORKSPACE"] ?? findRepoRoot(process.cwd()))
  setBasePath(currentWorkspace)
  setShellCwd(currentWorkspace)
  console.log(`📂 Agent workspace: ${currentWorkspace}`)

  // Load LLM config from DB (or use defaults) and build the client
  const llmCfg = getLlmConfig()
  const llm = buildLlmClient(llmCfg)
  console.log(`🧠 LLM: ${llmCfg.provider} / ${llmCfg.model}`)

  // Create orchestrator (tools are resolved per-run from agent definitions)
  const orchestrator = new AgentOrchestrator({
    llm,
    workspace: currentWorkspace,
  })

  // ── Message routing (WhatsApp + Messenger) ───────────────────

  const queueStore = new SqliteQueueStore()
  const conversationStore = new SqliteConversationStore()
  const messageQueue = new MessageQueue(queueStore)
  const messageRouter = new MessageRouter(messageQueue, conversationStore, orchestrator)

  // Wire the router into the orchestrator (for reply delivery)
  orchestrator.setMessageRouter(messageRouter)

  // Load configured channels from the database
  const channelConfigs = listChannelConfigs()
  for (const cfg of channelConfigs) {
    const channel = cfg.type === "whatsapp"
      ? new WhatsAppChannel(cfg)
      : new MessengerChannel(cfg)

    messageQueue.registerChannel(channel)
    messageRouter.registerChannel(channel)
    console.log(`📡 Channel loaded: ${cfg.type} (${cfg.platformId})`)
  }

  // Start the delivery queue (recovers pending messages)
  messageQueue.start()

  // Create Fastify app
  const app = Fastify({ logger: false })

  // Plugins
  await app.register(cors, { origin: true })
  await app.register(websocket)

  // WebSocket endpoint
  app.get("/ws", { websocket: true }, (socket) => {
    addClient(socket)
  })

  // REST routes
  registerRunRoutes(app, orchestrator)
  registerAgentRoutes(app, orchestrator)
  registerLayoutRoutes(app)
  registerPolicyRoutes(app)
  registerUsageRoutes(app)
  registerWebhookRoutes(app, messageRouter, messageQueue)
  registerNotificationRoutes(app, orchestrator)
  registerMemoryRoutes(app, orchestrator)
  registerLlmRoutes(app, (newClient) => {
    orchestrator.setLlm(newClient)
    console.log("🔄 LLM client hot-swapped")
  })

  // Health check
  app.get("/api/health", async () => ({
    status: "ok",
    active: orchestrator.getActiveRunIds().length,
    channels: messageRouter.listChannels(),
    queuePending: messageQueue.pendingCount,
    runQueue: orchestrator.getQueueStats(),
  }))

  // Workspace — get/set the agent's working directory
  app.get("/api/workspace", async () => ({
    path: currentWorkspace,
  }))

  app.put<{ Body: { path: string } }>("/api/workspace", async (req, reply) => {
    const { path: newPath } = req.body
    if (!newPath || typeof newPath !== "string") {
      reply.code(400)
      return { error: "path is required" }
    }

    const resolved = resolve(newPath)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      reply.code(400)
      return { error: "Path does not exist or is not a directory" }
    }

    currentWorkspace = resolved
    setBasePath(resolved)
    setShellCwd(resolved)
    orchestrator.setWorkspace(resolved)
    console.log(`📂 Workspace changed to: ${resolved}`)

    return { ok: true, path: resolved }
  })

  // Reset transactional data (keeps policies + layouts)
  app.delete("/api/data", async () => {
    clearTransactionalData()
    return { ok: true }
  })

  // Start
  await app.listen({ port: PORT, host: HOST })

  // Auto-recover stale runs from previous server crash
  const recovery = orchestrator.recoverStaleRuns()
  if (recovery.failed.length > 0) {
    console.log(`🔄 Recovered ${recovery.recovered.length} stale runs, ${recovery.failed.length} marked failed`)
  }

  console.log(`\n${"═".repeat(50)}`)
  console.log(`  AGENT001 COMMAND CENTER`)
  console.log(`${"═".repeat(50)}`)
  console.log(`  Server:    http://localhost:${PORT}`)
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`)
  console.log(`  API:       http://localhost:${PORT}/api`)
  console.log(`  Webhooks:  http://localhost:${PORT}/webhooks/{whatsapp,messenger}`)
  console.log(`  Dashboard: http://localhost:5179 (dev)`)
  console.log(`  Channels:  ${channelConfigs.length > 0 ? channelConfigs.map(c => c.type).join(", ") : "none (configure via POST /api/channels)"}`)
  console.log(`${"═".repeat(50)}\n`)

  // Graceful shutdown for tsx hot-reload
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      messageQueue.stop()
      process.exit(0)
    })
  }
}

main().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})
