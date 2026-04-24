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

// Load .env — from CWD when running as installed package, from monorepo root in dev
const _pkgRoot = process.env["AGENT001_PACKAGE_ROOT"]
const _projectRoot = _pkgRoot ? process.cwd() : resolve(import.meta.dirname, "../../..")
config({
  path: resolve(_projectRoot, ".env"),
})

import {
    buildCatalog, closeMssqlPool, loadLineage, setBasePath,
    setBrowserCheckCwd,
    setBrowserCheckExecutor,
    setSearchBasePath,
    setShellCwd,
    setShellExecutor,
    setShellSandboxStrict
} from "@agent001/agent"
import cookie from "@fastify/cookie"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import websocket from "@fastify/websocket"
import Fastify from "fastify"
import { registerIdentity } from "./auth/identity.js"
import { buildBrowserScript, formatBrowserReport } from "./browser-helpers.js"
import {
    MessageQueue,
    MessageRouter,
    SqliteConversationStore,
    SqliteQueueStore,
    TeamsChannel,
    listChannelConfigs,
    migrateChannels,
} from "./channels/index.js"
import {
    clearTransactionalData,
    getDb, getDbStats, getLlmConfig,
    migrateApiRequests, migrateEventLog, migrateNotifications, migrateWebhookDrains,
    pruneOldData, saveApiRequest,
} from "./db.js"
import { buildLlmClient } from "./llm/registry.js"
import { migrateMemory, prune as pruneMemory } from "./memory.js"
import { AgentOrchestrator } from "./orchestrator.js"
import {
    registerAdminRoutes,
    registerAgentRoutes,
    registerEventRoutes,
    registerLayoutRoutes,
    registerLlmRoutes,
    registerMemoryRoutes,
    registerMymiRoutes,
    registerNotificationRoutes,
    registerPolicyRoutes,
    registerRunRoutes,
    registerUsageRoutes,
    registerWebhookRoutes,
} from "./routes/index.js"
import { initSandbox } from "./sandbox.js"
import { setupMssql } from "./setup-mssql.js"
import { addClient, addSseClient, broadcast } from "./ws.js"

const PORT = Number(process.env["PORT"] ?? 3102)
const HOST = process.env["HOST"] ?? "0.0.0.0"

async function main() {
  initDatabase()

  let currentWorkspace = resolveWorkspace()
  const sandbox = await configureSandbox(() => currentWorkspace)
  const mssqlSummary = setupMssql(_projectRoot)
  const llm = await buildLlmAndCatalog(mssqlSummary)

  const orchestrator = new AgentOrchestrator({ llm, workspace: currentWorkspace })
  const { messageQueue, messageRouter, channelConfigs } = initMessaging(orchestrator)
  const uiDist = resolveUiDist()

  const app = await buildApp({
    orchestrator,
    messageQueue,
    messageRouter,
    uiDist,
    getWorkspace: () => currentWorkspace,
    setWorkspace: (w) => { currentWorkspace = w; applyWorkspace(w, orchestrator) },
  })

  await app.listen({ port: PORT, host: HOST })
  recoverStaleRuns(orchestrator)
  printBanner({ mssqlSummary, channelConfigs, uiDist })
  registerShutdown({ sandbox, messageQueue })
}

// ── Bootstrap phase functions ─────────────────────────────────

function resolveUiDist(): string {
  return _pkgRoot
    ? resolve(_pkgRoot, "dist/ui")
    : resolve(import.meta.dirname, "../../../packages/ui/dist")
}

function applyWorkspace(w: string, orchestrator: AgentOrchestrator): void {
  setBasePath(w)
  setSearchBasePath(w)
  setShellCwd(w)
  setBrowserCheckCwd(w)
  orchestrator.setWorkspace(w)
}

function recoverStaleRuns(orchestrator: AgentOrchestrator): void {
  const recovery = orchestrator.recoverStaleRuns()
  if (recovery.failed.length > 0) {
    console.log(`Recovered ${recovery.recovered.length} stale runs, ${recovery.failed.length} marked failed`)
  }
}

function registerShutdown({ sandbox, messageQueue }: { sandbox: ReturnType<typeof initSandbox>; messageQueue: MessageQueue }): void {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      messageQueue.stop()
      await closeMssqlPool()
      await sandbox.cleanup()
      process.exit(0)
    })
  }
}

function initDatabase(): void {
  getDb()
  migrateChannels()
  migrateNotifications()
  migrateApiRequests()
  migrateEventLog()
  migrateWebhookDrains()
  migrateMemory()
  console.log("Database initialized (~/.agent001/agent001.db)")

  const pruneResult = pruneOldData()
  if (pruneResult.prunedRuns > 0 || pruneResult.prunedApiRequests > 0) {
    console.log(`Pruned ${pruneResult.prunedRuns} old runs, ${pruneResult.prunedApiRequests} API request logs`)
  }

  const memPrune = pruneMemory()
  if (memPrune.deleted > 0) {
    console.log(`Pruned ${memPrune.deleted} stale/duplicate memory entries`)
  }
}

function resolveWorkspace(): string {
  function findRepoRoot(from: string): string {
    let dir = resolve(from)
    while (dir !== resolve(dir, "..")) {
      if (existsSync(resolve(dir, ".git"))) return dir
      dir = resolve(dir, "..")
    }
    return from
  }
  const workspace = resolve(process.env["AGENT_WORKSPACE"] ?? findRepoRoot(process.cwd()))
  setBasePath(workspace)
  setSearchBasePath(workspace)
  setShellCwd(workspace)
  setBrowserCheckCwd(workspace)
  console.log(`Agent workspace: ${workspace}`)
  return workspace
}

async function configureSandbox(getWorkspace: () => string): Promise<ReturnType<typeof initSandbox>> {
  const sandboxMode = process.env["SANDBOX_MODE"] === "host"
    ? "host" as const
    : process.env["SANDBOX_MODE"] === "all"
      ? "all" as const
      : "docker" as const
  const sandbox = initSandbox({ mode: sandboxMode })
  const dockerReady = await sandbox.isDockerAvailable()

  if (dockerReady) {
    setShellExecutor(async (command, cwd, signal) => {
      return sandbox.exec(command, cwd || getWorkspace(), { signal })
    })
    if (sandbox.isStrictMode) {
      setShellSandboxStrict(true)
      console.log("Docker sandbox: STRICT mode (all commands require Docker, relaxed deny list)")
    } else {
      console.log("Docker sandbox: ACTIVE (commands run in isolated containers)")
    }

    // Build browser image in background — don't block startup
    sandbox.ensureBrowserImage().then((ready) => {
      if (ready) {
        setBrowserCheckExecutor(async (htmlPath, clicks, waitMs, cwd) => {
          const script = buildBrowserScript(htmlPath, clicks, waitMs)
          const result = await sandbox.browserExec(script, cwd || getWorkspace(), { timeout: 30_000 })
          if (result.stderr === "FALLBACK_TO_HOST") throw new Error("Browser image not available")
          if (result.exitCode !== 0) {
            return { report: `Error: ${result.stderr || result.stdout || "Browser check failed in container"}`, sandboxed: true }
          }
          try {
            return { report: formatBrowserReport(JSON.parse(result.stdout)), sandboxed: true }
          } catch {
            return { report: result.stdout || "(no output)", sandboxed: true }
          }
        })
        console.log("Browser sandbox: ACTIVE (browser_check runs in isolated containers)")
      } else {
        console.log("Browser sandbox: UNAVAILABLE (browser_check runs on host)")
      }
    })
  } else {
    if (sandbox.isStrictMode) {
      console.error("SANDBOX_MODE=all requires Docker but Docker is not available. Aborting.")
      process.exit(1)
    }
    console.log("Docker sandbox: UNAVAILABLE (commands run on host with filtered env)")
  }

  return sandbox
}

async function buildLlmAndCatalog(mssqlSummary: string) {
  const llmCfg = getLlmConfig()
  const llm = buildLlmClient(llmCfg)
  console.log(`LLM: ${llmCfg.provider} / ${llmCfg.model}`)

  if (mssqlSummary !== "not configured") {
    try {
      const maxAgeHours = Number(process.env.CATALOG_MAX_AGE_HOURS || 168)
      const cachePath = process.env.CATALOG_CACHE_PATH || "./data/catalog-cache.json"
      console.log(`Loading schema catalog (cache: ${cachePath}, max age: ${maxAgeHours}h)...`)
      const catalog = await buildCatalog({ cachePath, maxAgeMs: maxAgeHours * 3600_000 })
      const s = catalog.stats()
      const ageH = Math.round((Date.now() - catalog.builtAt.getTime()) / 3600000)
      const source = ageH < 1 ? "built fresh from MSSQL" : `loaded from cache (${ageH}h old)`
      console.log(`Schema catalog ${source}: ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs, ${s.implicitEdges} implicit join edges`)

      const lineagePath = process.env.LINEAGE_FILE || resolve(_projectRoot, "deploy/mssql/lineage.json")
      try {
        const count = await loadLineage(lineagePath)
        console.log(`Lineage maps loaded: ${count} critical view(s) from ${lineagePath}`)
      } catch {
        // Non-fatal — lineage file may not exist
      }
    } catch (e) {
      console.warn("Failed to build schema catalog:", e instanceof Error ? e.message : e)
    }
  }

  return llm
}

function initMessaging(orchestrator: AgentOrchestrator) {
  const queueStore = new SqliteQueueStore()
  const conversationStore = new SqliteConversationStore()
  const messageQueue = new MessageQueue(queueStore)
  const messageRouter = new MessageRouter(messageQueue, conversationStore, orchestrator)
  orchestrator.setMessageRouter(messageRouter)

  const channelConfigs = listChannelConfigs()
  for (const cfg of channelConfigs) {
    if (cfg.type === "teams") {
      const channel = new TeamsChannel(cfg)
      messageQueue.registerChannel(channel)
      messageRouter.registerChannel(channel)
      console.log(`Channel loaded: teams (appId: ${cfg.platformId})`)
    }
  }
  messageQueue.start()

  return { messageQueue, messageRouter, channelConfigs }
}

interface AppOpts {
  orchestrator: AgentOrchestrator
  messageQueue: MessageQueue
  messageRouter: MessageRouter
  uiDist: string
  getWorkspace: () => string
  setWorkspace: (w: string) => void
}

async function buildApp(opts: AppOpts) {
  const { orchestrator, messageQueue, messageRouter, uiDist, getWorkspace, setWorkspace } = opts

  // trustProxy: when behind a corporate HTTPS terminator (proxy-https, IIS,
  // nginx) Fastify needs to honour X-Forwarded-* headers so req.ip reflects
  // the real client and Secure cookies survive the hop.
  const app = Fastify({ logger: false, trustProxy: true })
  await app.register(cors, { origin: true, credentials: true })
  await app.register(cookie, { secret: process.env["AGENT001_COOKIE_SECRET"] ?? undefined })
  await app.register(websocket)

  // Identity middleware — resolves req.session and seeds AsyncLocalStorage.
  // Must be registered AFTER @fastify/cookie. Adds GET/POST /api/me.
  await registerIdentity(app)

  app.addHook("onRequest", (req, _reply, done) => {
    ;(req as any)._startTime = Date.now()
    done()
  })
  app.addHook("onResponse", (req, reply, done) => {
    if (req.url.startsWith("/ws") || req.url.startsWith("/api/events/stream") || (!req.url.startsWith("/api") && !req.url.startsWith("/webhooks"))) {
      done()
      return
    }
    const duration = Date.now() - ((req as any)._startTime ?? Date.now())
    const entry = {
      method: req.method,
      url: req.url,
      status_code: reply.statusCode,
      duration_ms: duration,
      request_body: req.body ? JSON.stringify(req.body).slice(0, 2048) : null,
      response_summary: null,
      created_at: new Date().toISOString(),
    }
    try {
      saveApiRequest(entry)
      broadcast({ type: "api.request", data: entry as unknown as Record<string, unknown> })
    } catch { /* don't break responses if logging fails */ }
    // Multi-user observability: stamp user identity on console for ops greppability.
    // Only for non-trivial endpoints (skip /api/me polling noise).
    if (!req.url.startsWith("/api/me") && !req.url.startsWith("/api/admin/sessions") && !req.url.startsWith("/api/admin/active-runs") && !req.url.startsWith("/api/admin/users")) {
      const s = (req as { session?: { upn?: string | null; displayName?: string; sid?: string } }).session
      const who = s?.upn ?? s?.displayName ?? s?.sid?.slice(0, 12) ?? "anon"
      console.log(`[${who}] ${req.method} ${req.url} → ${reply.statusCode} (${duration}ms)`)
    }
    done()
  })

  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: "/", wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws") || req.url.startsWith("/webhooks")) {
        reply.code(404).send({ error: "Not found" })
      } else {
        reply.sendFile("index.html")
      }
    })
  }

  app.setErrorHandler((error, _req, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    const message = error instanceof Error ? error.message : "Internal server error"
    if (status >= 500) console.error("[server] unhandled route error:", error)
    reply.code(status).send({ error: message })
  })

  app.get("/ws", { websocket: true }, (socket, req) => {
    // The identity middleware ran before this handler — req.session is set.
    addClient(socket, {
      upn:     req.session?.upn ?? null,
      sid:     req.session?.sid ?? "anon",
      isAdmin: req.session?.isAdmin ?? false,
    })
  })

  // Server-Sent Events fallback for deployments behind HTTP-only reverse
  // proxies that don't forward WebSocket upgrades. Same broadcaster, same
  // per-user filtering. The UI prefers this transport when available.
  app.get("/api/events/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    const dispose = addSseClient(reply.raw, {
      upn:     req.session?.upn ?? null,
      sid:     req.session?.sid ?? "anon",
      isAdmin: req.session?.isAdmin ?? false,
    })
    // Heartbeat every 25s — keeps intermediaries from idle-closing the stream.
    const heartbeat = setInterval(() => {
      try { reply.raw.write(`: ping\n\n`) } catch { /* dropped */ }
    }, 25_000)
    req.raw.on("close", () => { clearInterval(heartbeat); dispose() })
  })

  registerRunRoutes(app, orchestrator)
  registerAgentRoutes(app, orchestrator)
  registerLayoutRoutes(app)
  registerPolicyRoutes(app)
  registerUsageRoutes(app)
  registerMymiRoutes(app)
  registerEventRoutes(app)
  registerWebhookRoutes(app, messageRouter, messageQueue)
  registerNotificationRoutes(app, orchestrator)
  registerMemoryRoutes(app, orchestrator)
  registerLlmRoutes(app, (newClient) => {
    orchestrator.setLlm(newClient)
    console.log("LLM client hot-swapped")
  })
  registerAdminRoutes(app, orchestrator)

  app.get("/api/health", async () => ({
    status: "ok",
    active: orchestrator.getActiveRunIds().length,
    channels: messageRouter.listChannels(),
    queuePending: messageQueue.pendingCount,
    runQueue: orchestrator.getQueueStats(),
  }))

  app.get("/api/workspace", async () => ({ path: getWorkspace() }))

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
    setWorkspace(resolved)
    console.log(`Workspace changed to: ${resolved}`)
    return { ok: true, path: resolved }
  })

  app.delete("/api/data", async () => { clearTransactionalData(); return { ok: true } })

  app.get("/api/db/stats", async () => getDbStats())

  app.post<{ Body: { keepRuns?: number; keepApiRequests?: number; keepNotifications?: number } }>(
    "/api/db/prune",
    async (req) => ({ ok: true, ...pruneOldData(req.body ?? {}) }),
  )

  return app
}

function printBanner({ mssqlSummary, channelConfigs, uiDist }: {
  mssqlSummary: string
  channelConfigs: Array<{ type: string }>
  uiDist: string
}): void {
  const uiExists = existsSync(uiDist)
  console.log(`\n${"═".repeat(50)}`)
  console.log(`  AGENT001 COMMAND CENTER`)
  console.log(`${"═".repeat(50)}`)
  console.log(`  Server:    http://localhost:${PORT}`)
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`)
  console.log(`  API:       http://localhost:${PORT}/api`)
  console.log(`  Teams:     ${uiExists ? `https://<host>/webhooks/teams` : `http://localhost:${PORT}/webhooks/teams`}`)
  console.log(`  Dashboard: ${uiExists ? `http://localhost:${PORT}` : "http://localhost:5179 (dev)"}`)
  console.log(`  Channels:  ${channelConfigs.length > 0 ? channelConfigs.map(c => c.type).join(", ") : "none (configure via POST /api/channels)"}`)
  console.log(`  MSSQL:     ${mssqlSummary}`)
  console.log(`${"═".repeat(50)}\n`)
}

main().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})
