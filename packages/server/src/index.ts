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
import { resolve } from "node:path"

// Load .env from repo root (npm workspaces sets CWD to packages/server)
config({ path: resolve(import.meta.dirname, "../../../.env") })

import {
  fetchUrlTool,
  listDirectoryTool,
  readFileTool,
  setBasePath,
  setShellCwd,
  shellTool,
  thinkTool,
  writeFileTool,
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
import { clearTransactionalData, getDb } from "./db.js"
import { CopilotClient } from "./llm/copilot.js"
import { AgentOrchestrator } from "./orchestrator.js"
import { registerLayoutRoutes } from "./routes/layouts.js"
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
  console.log("📦 Database initialized (~/.agent001/agent001.db)")

  // Set agent workspace — all file/shell operations are scoped here
  const workspace = resolve(process.env["AGENT_WORKSPACE"] ?? process.cwd())
  setBasePath(workspace)
  setShellCwd(workspace)
  console.log(`📂 Agent workspace: ${workspace}`)

  // Create LLM client (token resolved lazily — server starts without it)
  const llm = new CopilotClient({
    model: process.env["MODEL"] ?? "gpt-4o",
  })
  const hasToken = !!process.env["GITHUB_TOKEN"]
  console.log(
    hasToken
      ? `🧠 LLM: GitHub Copilot (${process.env["MODEL"] ?? "gpt-4o"})`
      : "⚠️  No GITHUB_TOKEN — server will start but agent runs will fail until token is set",
  )

  // Create orchestrator
  const orchestrator = new AgentOrchestrator({
    llm,
    tools: [fetchUrlTool, readFileTool, writeFileTool, listDirectoryTool, shellTool, thinkTool],
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
  registerLayoutRoutes(app)
  registerPolicyRoutes(app)
  registerUsageRoutes(app)
  registerWebhookRoutes(app, messageRouter)

  // Health check
  app.get("/api/health", async () => ({
    status: "ok",
    active: orchestrator.getActiveRunIds().length,
    channels: messageRouter.listChannels(),
    queuePending: messageQueue.pendingCount,
  }))

  // Reset transactional data (keeps policies + layouts)
  app.delete("/api/data", async () => {
    clearTransactionalData()
    return { ok: true }
  })

  // Start
  await app.listen({ port: PORT, host: HOST })

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
