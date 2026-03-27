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

import {
    fetchUrlTool,
    listDirectoryTool,
    readFileTool,
    shellTool,
    thinkTool,
    writeFileTool,
} from "@agent001/agent"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import Fastify from "fastify"
import { getDb } from "./db.js"
import { CopilotClient } from "./llm/copilot.js"
import { AgentOrchestrator } from "./orchestrator.js"
import { registerLayoutRoutes } from "./routes/layouts.js"
import { registerRunRoutes } from "./routes/runs.js"
import { addClient } from "./ws.js"

const PORT = Number(process.env["PORT"] ?? 3001)
const HOST = process.env["HOST"] ?? "0.0.0.0"

async function main() {
  // Initialize database
  getDb()
  console.log("📦 Database initialized (~/.agent001/agent001.db)")

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

  // Health check
  app.get("/api/health", async () => ({
    status: "ok",
    active: orchestrator.getActiveRunIds().length,
  }))

  // Start
  await app.listen({ port: PORT, host: HOST })

  console.log(`\n${"═".repeat(50)}`)
  console.log(`  AGENT001 COMMAND CENTER`)
  console.log(`${"═".repeat(50)}`)
  console.log(`  Server:    http://localhost:${PORT}`)
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`)
  console.log(`  API:       http://localhost:${PORT}/api`)
  console.log(`  Dashboard: http://localhost:5173 (dev)`)
  console.log(`${"═".repeat(50)}\n`)
}

main().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})
