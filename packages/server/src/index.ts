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
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

// Load .env — from CWD when running as installed package, from monorepo root in dev
const _pkgRoot = process.env["AGENT001_PACKAGE_ROOT"]
const _projectRoot = _pkgRoot ? process.cwd() : resolve(import.meta.dirname, "../../..")
config({
  path: resolve(_projectRoot, ".env"),
})

import {
    buildCatalog,
    closeMssqlPool,
    loadLineage,
    setBasePath,
    setBrowserCheckCwd,
    setBrowserCheckExecutor,
    setMssqlConfig,
    setMssqlConfigs,
    setMssqlWriteEnabled,
    setSearchBasePath,
    setShellCwd,
    setShellExecutor,
    setShellSandboxStrict,
} from "@agent001/agent"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import websocket from "@fastify/websocket"
import Fastify from "fastify"
import {
    MessageQueue,
    MessageRouter,
    SqliteConversationStore,
    SqliteQueueStore,
    TeamsChannel,
    listChannelConfigs,
    migrateChannels,
} from "./channels/index.js"
import { clearTransactionalData, getDb, getDbStats, getLlmConfig, migrateApiRequests, migrateEventLog, migrateNotifications, migrateWebhookDrains, pruneOldData, saveApiRequest } from "./db.js"
import { buildLlmClient } from "./llm/registry.js"
import { prune as pruneMemory } from "./memory.js"
import { AgentOrchestrator } from "./orchestrator.js"
import { registerAgentRoutes } from "./routes/agents.js"
import { registerEventRoutes } from "./routes/events.js"
import { registerLayoutRoutes } from "./routes/layouts.js"
import { registerLlmRoutes } from "./routes/llm.js"
import { registerMemoryRoutes } from "./routes/memory.js"
import { registerNotificationRoutes } from "./routes/notifications.js"
import { registerPolicyRoutes } from "./routes/policies.js"
import { registerRunRoutes } from "./routes/runs.js"
import { registerUsageRoutes } from "./routes/usage.js"
import { registerWebhookRoutes } from "./routes/webhooks.js"
import { initSandbox } from "./sandbox.js"
import { addClient, broadcast } from "./ws.js"

const PORT = Number(process.env["PORT"] ?? 3102)
const HOST = process.env["HOST"] ?? "0.0.0.0"

async function main() {
  // Initialize database
  getDb()
  migrateChannels()
  migrateNotifications()
  migrateApiRequests()
  migrateEventLog()
  migrateWebhookDrains()
  console.log("Database initialized (~/.agent001/agent001.db)")

  // Auto-prune old data on startup
  const pruneResult = pruneOldData()
  if (pruneResult.prunedRuns > 0 || pruneResult.prunedApiRequests > 0) {
    console.log(`Pruned ${pruneResult.prunedRuns} old runs, ${pruneResult.prunedApiRequests} API request logs`)
  }

  // Prune duplicate episodic memory entries left over from pre-upsert-fix runs
  const memPrune = pruneMemory()
  if (memPrune.deleted > 0) {
    console.log(`Pruned ${memPrune.deleted} stale/duplicate memory entries`)
  }

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
  setSearchBasePath(currentWorkspace)
  setShellCwd(currentWorkspace)
  setBrowserCheckCwd(currentWorkspace)
  console.log(`📂 Agent workspace: ${currentWorkspace}`)

  // Initialize Docker sandbox for isolated code execution
  const sandboxMode = process.env["SANDBOX_MODE"] === "host"
    ? "host" as const
    : process.env["SANDBOX_MODE"] === "all"
      ? "all" as const
      : "docker" as const
  const sandbox = initSandbox({ mode: sandboxMode })
  const dockerReady = await sandbox.isDockerAvailable()
  if (dockerReady) {
    setShellExecutor(async (command, cwd, signal) => {
      const workspaceForRun = cwd || currentWorkspace
      const result = await sandbox.exec(command, workspaceForRun, { signal })
      return result
    })
    if (sandbox.isStrictMode) {
      setShellSandboxStrict(true)
      console.log("Docker sandbox: STRICT mode (all commands require Docker, relaxed deny list)")
    } else {
      console.log("Docker sandbox: ACTIVE (commands run in isolated containers)")
    }

    // Build browser image in background (don't block startup)
    sandbox.ensureBrowserImage().then((ready) => {
      if (ready) {
        setBrowserCheckExecutor(async (htmlPath, clicks, waitMs, cwd) => {
          const script = buildBrowserScript(htmlPath, clicks, waitMs)
          const workspaceForRun = cwd || currentWorkspace
          const result = await sandbox.browserExec(script, workspaceForRun, { timeout: 30_000 })

          if (result.stderr === "FALLBACK_TO_HOST") {
            throw new Error("Browser image not available")
          }

          // Parse the JSON output from the container script
          if (result.exitCode !== 0) {
            const errMsg = result.stderr || result.stdout || "Browser check failed in container"
            return { report: `Error: ${errMsg}`, sandboxed: true }
          }

          try {
            const parsed = JSON.parse(result.stdout)
            return { report: formatBrowserReport(parsed), sandboxed: true }
          } catch {
            // If JSON parsing fails, return raw output
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

  // ── MSSQL configuration ───────────────────────────────────────
  //
  // Priority (highest wins):
  //   1. MSSQL_DATABASES — JSON array of named connections
  //   2. MSSQL_HOST      — single connection (backwards-compat)
  //
  // Each connection can have an optional knowledgePath pointing to a
  // Markdown file that describes the database schema, business context,
  // and domain meaning.  This is injected into the system prompt so the
  // agent understands the database without runtime discovery.
  //
  // The dev-only Docker DB (mssql-dev) is never auto-connected here.
  // To use it during development, set MSSQL_HOST=localhost in your .env.

  function readKnowledgeFile(filePath: string): string | null {
    const resolved = resolve(_projectRoot, filePath)
    try {
      if (!existsSync(resolved)) {
        console.warn(`MSSQL knowledge file not found: ${resolved}`)
        return null
      }
      const content = readFileSync(resolved, "utf-8").trim()
      if (!content) return null
      console.log(`MSSQL knowledge loaded: ${resolved} (${content.length} chars)`)
      return content
    } catch (e) {
      console.warn(`Failed to read MSSQL knowledge file: ${resolved}`, e instanceof Error ? e.message : e)
      return null
    }
  }

  let mssqlSummary = "not configured"

  const mssqlDatabasesJson = process.env["MSSQL_DATABASES"]
  if (mssqlDatabasesJson) {
    // ── Multi-database mode ──────────────────────────────────────
    // MSSQL_DATABASES is a JSON array. Each entry:
    //   { name, host, port?, database?, user?, password?, domain?,
    //     encrypt?, trustServerCertificate?, writeEnabled? }
    // "domain" enables Windows/NTLM auth (same as MSSQL_DOMAIN in single mode).
    let dbConfigs: Array<{
      name: string
      host: string
      port?: number
      user?: string
      password?: string
      domain?: string
      database?: string
      encrypt?: boolean
      trustServerCertificate?: boolean
      writeEnabled?: boolean
      knowledgePath?: string
    }>
    try {
      dbConfigs = JSON.parse(mssqlDatabasesJson)
      if (!Array.isArray(dbConfigs)) throw new Error("MSSQL_DATABASES must be a JSON array")
    } catch (e) {
      console.error("Invalid MSSQL_DATABASES JSON:", e instanceof Error ? e.message : e)
      process.exit(1)
    }

    setMssqlConfigs(
      dbConfigs.map((db) => ({
        name: db.name,
        server: db.host,
        port: db.port ?? 1433,
        ...(db.domain ? { domain: db.domain } : {}),
        user: db.user ?? "sa",
        password: db.password ?? "",
        database: db.database ?? "master",
        options: {
          encrypt: db.encrypt !== false,
          trustServerCertificate: db.trustServerCertificate !== false,
        },
        writeEnabled: db.writeEnabled ?? false,
        knowledge: db.knowledgePath ? readKnowledgeFile(db.knowledgePath) : null,
      })),
    )

    for (const db of dbConfigs) {
      if (db.writeEnabled) {
        setMssqlWriteEnabled(true, db.name)
      }
    }

    mssqlSummary = dbConfigs.map((db) => `${db.name}(${db.host}/${db.database ?? "master"})`).join(", ")
    console.log(`🗄️  MSSQL databases: ${mssqlSummary}`)
  } else {
    // ── Single-database mode (backwards-compat / .env MSSQL_HOST) ─
    const mssqlServer = process.env["MSSQL_HOST"] || process.env["MSSQL_SERVER"]
    if (mssqlServer) {
      const domain = process.env["MSSQL_DOMAIN"]
      const knowledgePath = process.env["MSSQL_KNOWLEDGE_FILE"]
      setMssqlConfig({
        server: mssqlServer,
        port: Number(process.env["MSSQL_PORT"] ?? 1433),
        ...(domain ? { domain } : {}),
        user: process.env["MSSQL_USER"] ?? "sa",
        password: process.env["MSSQL_PASSWORD"] ?? "",
        database: process.env["MSSQL_DATABASE"] ?? "master",
        options: {
          encrypt: process.env["MSSQL_ENCRYPT"] !== "false",
          trustServerCertificate: process.env["MSSQL_TRUST_CERT"] !== "false",
        },
      }, "default", knowledgePath ? readKnowledgeFile(knowledgePath) : null)
      if (process.env["MSSQL_WRITE_ENABLED"] === "true") {
        setMssqlWriteEnabled(true)
        mssqlSummary = `${mssqlServer} (WRITE mode enabled)`
      } else {
        mssqlSummary = `${mssqlServer} (read-only)`
      }
      console.log(`🗄️  MSSQL: ${mssqlSummary}`)
    }
  }

  // Load LLM config from DB (or use defaults) and build the client
  const llmCfg = getLlmConfig()
  const llm = buildLlmClient(llmCfg)
  console.log(`LLM: ${llmCfg.provider} / ${llmCfg.model}`)

  // Build schema catalog (persistent knowledge graph of entire DB structure)
  if (mssqlSummary !== "not configured") {
    try {
      const maxAgeHours = Number(process.env.CATALOG_MAX_AGE_HOURS || 168)
      const cachePath = process.env.CATALOG_CACHE_PATH || "./data/catalog-cache.json"
      console.log(`Loading schema catalog (cache: ${cachePath}, max age: ${maxAgeHours}h)...`)
      const catalog = await buildCatalog({
        cachePath,
        maxAgeMs: maxAgeHours * 3600_000,
      })
      const s = catalog.stats()
      const ageH = Math.round((Date.now() - catalog.builtAt.getTime()) / 3600000)
      const source = ageH < 1 ? "built fresh from MSSQL" : `loaded from cache (${ageH}h old)`
      console.log(`📊 Schema catalog ${source}: ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs, ${s.implicitEdges} implicit join edges`)

      // Load curated lineage maps (if file exists)
      const lineagePath = process.env.LINEAGE_FILE || resolve(_projectRoot, "deploy/mssql/lineage.json")
      try {
        const count = await loadLineage(lineagePath)
        console.log(`📊 Lineage maps loaded: ${count} critical view(s) from ${lineagePath}`)
      } catch {
        // Non-fatal — lineage is optional (file may not exist)
      }
    } catch (e) {
      console.warn("⚠️  Failed to build schema catalog:", e instanceof Error ? e.message : e)
    }
  }

  // Create orchestrator (tools are resolved per-run from agent definitions)
  const orchestrator = new AgentOrchestrator({
    llm,
    workspace: currentWorkspace,
  })

  // ── Message routing (Teams) ───────────────────────────────

  const queueStore = new SqliteQueueStore()
  const conversationStore = new SqliteConversationStore()
  const messageQueue = new MessageQueue(queueStore)
  const messageRouter = new MessageRouter(messageQueue, conversationStore, orchestrator)

  // Wire the router into the orchestrator (for reply delivery)
  orchestrator.setMessageRouter(messageRouter)

  // Load configured channels from the database
  const channelConfigs = listChannelConfigs()
  for (const cfg of channelConfigs) {
    if (cfg.type === "teams") {
      const channel = new TeamsChannel(cfg)
      messageQueue.registerChannel(channel)
      messageRouter.registerChannel(channel)
      console.log(`Channel loaded: teams (appId: ${cfg.platformId})`)
    }
  }

  // Start the delivery queue (recovers pending messages)
  messageQueue.start()

  // Create Fastify app
  const app = Fastify({ logger: false })

  // Plugins
  await app.register(cors, { origin: true })
  await app.register(websocket)

  // ── REST API request logging (DB + WS broadcast) ───────────
  app.addHook("onRequest", (req, _reply, done) => {
    ;(req as any)._startTime = Date.now()
    done()
  })
  app.addHook("onResponse", (req, reply, done) => {
    // Skip WebSocket upgrade and static file requests
    if (req.url.startsWith("/ws") || (!req.url.startsWith("/api") && !req.url.startsWith("/webhooks"))) {
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
    // Persist + broadcast (fire-and-forget to avoid slowing responses)
    try {
      saveApiRequest(entry)
      broadcast({
        type: "api.request",
        data: entry as unknown as Record<string, unknown>,
      })
    } catch { /* don't break responses if logging fails */ }
    done()
  })

  // Serve built UI — from dist/ui in package mode, packages/ui/dist in dev
  const uiDist = _pkgRoot
    ? resolve(_pkgRoot, "dist/ui")
    : resolve(import.meta.dirname, "../../../packages/ui/dist")
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, {
      root: uiDist,
      prefix: "/",
      wildcard: false,
    })
    // SPA fallback — serve index.html for non-API, non-WS routes
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws") || req.url.startsWith("/webhooks")) {
        reply.code(404).send({ error: "Not found" })
      } else {
        reply.sendFile("index.html")
      }
    })
  }

  // Global error handler — consistent 500 shape for uncaught route errors
  app.setErrorHandler((error, _req, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    const message = error instanceof Error ? error.message : "Internal server error"
    if (status >= 500) console.error("[server] unhandled route error:", error)
    reply.code(status).send({ error: message })
  })

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
  registerEventRoutes(app)
  registerWebhookRoutes(app, messageRouter, messageQueue)
  registerNotificationRoutes(app, orchestrator)
  registerMemoryRoutes(app, orchestrator)
  registerLlmRoutes(app, (newClient) => {
    orchestrator.setLlm(newClient)
    console.log("LLM client hot-swapped")
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
    setSearchBasePath(resolved)
    setShellCwd(resolved)
    setBrowserCheckCwd(resolved)
    orchestrator.setWorkspace(resolved)
    console.log(`Workspace changed to: ${resolved}`)

    return { ok: true, path: resolved }
  })

  // Reset transactional data (keeps policies + layouts)
  app.delete("/api/data", async () => {
    clearTransactionalData()
    return { ok: true }
  })

  // DB stats — row counts per table + file size
  app.get("/api/db/stats", async () => getDbStats())

  // Prune old data manually
  app.post<{ Body: { keepRuns?: number; keepApiRequests?: number; keepNotifications?: number } }>(
    "/api/db/prune",
    async (req) => {
      const result = pruneOldData(req.body ?? {})
      return { ok: true, ...result }
    },
  )

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
  console.log(`  Teams:     ${existsSync(uiDist) ? `https://<host>/webhooks/teams` : `http://localhost:${PORT}/webhooks/teams`}`)
  console.log(`  Dashboard: ${existsSync(uiDist) ? `http://localhost:${PORT}` : "http://localhost:5179 (dev)"}`)
  console.log(`  Channels:  ${channelConfigs.length > 0 ? channelConfigs.map(c => c.type).join(", ") : "none (configure via POST /api/channels)"}`)
  console.log(`  MSSQL:     ${mssqlSummary}`)
  console.log(`${"═".repeat(50)}\n`)

  // Graceful shutdown for tsx hot-reload
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      messageQueue.stop()
      await closeMssqlPool()
      await sandbox.cleanup()
      process.exit(0)
    })
  }
}

main().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})

// ── Browser sandbox helpers ──────────────────────────────────────

/**
 * Build a self-contained Node.js script that runs inside the browser container.
 * The script:
 *   1. Starts a static file server on a random port inside the container
 *   2. Launches Chromium via Puppeteer (container-installed)
 *   3. Navigates to the HTML file
 *   4. Collects errors for the specified wait time
 *   5. Performs any requested clicks
 *   6. Outputs a JSON result to stdout
 */
function buildBrowserScript(htmlPath: string, clicks: string[], waitMs: number): string {
  // Escape strings for embedding in the script
  const esc = (s: string) => JSON.stringify(s)
  return `
const http = require("http");
const fs = require("fs");
const path = require("path");
let puppeteer;
try {
  puppeteer = require("puppeteer");
} catch {
  try {
    puppeteer = require("/usr/local/lib/node_modules/puppeteer");
  } catch {
    puppeteer = require("/usr/lib/node_modules/puppeteer");
  }
}

const MIME = {
  ".html": "text/html", ".htm": "text/html", ".js": "application/javascript",
  ".mjs": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

async function main() {
  const htmlPath = ${esc(htmlPath)};
  const clicks = ${JSON.stringify(clicks)};
  const waitMs = ${waitMs};

  const fullPath = path.join("/workspace", htmlPath);
  const dir = path.dirname(fullPath);
  const fileName = path.basename(fullPath);

  // Static file server
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const relPath = (urlPath === "/" ? "index.html" : urlPath.replace(/^\\/+/, "")) || "index.html";
    const filePath = path.join(dir, relPath);
    if (!filePath.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not found"); }
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(null));
    server.on("error", reject);
  });
  const port = server.address().port;

  const consoleErrors = [];
  const consoleWarnings = [];
  const networkErrors = [];
  const uncaughtErrors = [];

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run"],
    });
    const page = await browser.newPage();

    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        const loc = msg.location();
        const errUrl = loc?.url || "";
        if (text.includes("Failed to load resource") && /favicon|apple-touch-icon/i.test(errUrl)) {
          // skip non-critical
        } else if (text.includes("Failed to load resource") && errUrl) {
          consoleErrors.push(text + " — URL: " + errUrl);
        } else {
          consoleErrors.push(text);
        }
      }
      else if (type === "warn") consoleWarnings.push(text);
    });
    page.on("pageerror", (err) => uncaughtErrors.push(String(err)));
    page.on("requestfailed", (req) => {
      const reqUrl = req.url();
      if (/favicon|apple-touch-icon/i.test(reqUrl)) return;
      networkErrors.push((req.failure()?.errorText || "failed") + ": " + reqUrl);
    });

    await page.goto("http://127.0.0.1:" + port + "/" + fileName, {
      waitUntil: "domcontentloaded", timeout: 15000,
    });

    await new Promise(r => setTimeout(r, waitMs));

    for (const selector of clicks) {
      try {
        await page.click(selector);
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        consoleErrors.push("Click failed on " + JSON.stringify(selector) + ": " + err.message);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }

  const result = { consoleErrors, consoleWarnings, networkErrors, uncaughtErrors };
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(err.message || String(err));
  process.exit(1);
});
`.trim()
}

/** Format the JSON result from the container browser script into a readable report. */
function formatBrowserReport(parsed: {
  consoleErrors?: string[]
  consoleWarnings?: string[]
  networkErrors?: string[]
  uncaughtErrors?: string[]
}): string {
  const consoleErrors = parsed.consoleErrors ?? []
  const consoleWarnings = parsed.consoleWarnings ?? []
  const networkErrors = parsed.networkErrors ?? []
  const uncaughtErrors = parsed.uncaughtErrors ?? []
  const totalErrors = consoleErrors.length + uncaughtErrors.length + networkErrors.length

  if (totalErrors === 0 && consoleWarnings.length === 0) {
    return "✓ No errors or warnings detected."
  }

  const lines: string[] = []
  if (uncaughtErrors.length > 0) {
    lines.push(`## Uncaught Exceptions (${uncaughtErrors.length})`)
    for (const e of uncaughtErrors) lines.push(`  - ${e}`)
  }
  if (consoleErrors.length > 0) {
    lines.push(`## Console Errors (${consoleErrors.length})`)
    for (const e of consoleErrors) lines.push(`  - ${e}`)
  }
  if (networkErrors.length > 0) {
    lines.push(`## Network Failures (${networkErrors.length})`)
    for (const e of networkErrors) lines.push(`  - ${e}`)
  }
  if (consoleWarnings.length > 0) {
    lines.push(`## Warnings (${consoleWarnings.length})`)
    for (const w of consoleWarnings) lines.push(`  - ${w}`)
  }
  lines.push("")
  lines.push(`Total: ${totalErrors} error(s), ${consoleWarnings.length} warning(s)`)
  return lines.join("\n")
}
