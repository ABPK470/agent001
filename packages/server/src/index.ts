/**
 * Server entry point — wires everything together.
 *
 * Starts Fastify with:
 *   - CORS (for dev: UI on different port)
 *   - SSE event stream (single real-time transport, see /api/events/stream)
 *   - Static file serving (production: serves built UI)
 *   - REST API routes (runs, layouts)
 *   - Agent orchestrator (starts/stops/resumes runs)
 *   - Copilot LLM client (GitHub Models API)
 */

import { config } from "dotenv"
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"

// Load .env — from CWD when running as installed package, from monorepo root in dev
const _pkgRoot = process.env["MIA_PACKAGE_ROOT"]
const _projectRoot = _pkgRoot ? process.cwd() : resolve(import.meta.dirname, "../../..")
config({
  path: resolve(_projectRoot, ".env"),
})

import cookie from "@fastify/cookie"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import {
    EventType,
    buildCatalog, closeMssqlPool, configurePlanStore, configureSyncOrchestrator, getMssqlConfig, loadLineage,
    setAttachmentService,
    setBasePath,
    setBrowserCheckCwd,
    setBrowserCheckExecutor,
    setBrowserContextProvider,
    setBrowserCredentialProvider,
    setBrowserHandoffProvider,
    setSearchBasePath,
    setShellCwd,
    setShellExecutor,
    setShellSandboxStrict,
    setSyncEventSink,
    setSyncRunSink,
    setupEnvironments
} from "@mia/agent"
import Fastify from "fastify"
import { pruneExpiredAttachments, serverAttachmentService } from "./attachments/index.js"
import { registerIdentity } from "./auth/identity.js"
import { bootstrapAdminFromEnv } from "./auth/users.js"
import { buildBrowserScript, formatBrowserReport } from "./browser-helpers.js"
import { serverBrowserCredentialProvider } from "./browser/credential-provider.js"
import { serverBrowserHandoffProvider } from "./browser/handoff-provider.js"
import { serverBrowserContextProvider } from "./browser/provider.js"
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
    getDb, getDbPath, getDbStats, getLlmConfig,
    getSyncRunPlanJson,
    migrateApiRequests, migrateEventLog, migrateNotifications, migrateWebhookDrains,
    normaliseUnknownRunStatuses,
    pruneOldData,
    recordSyncRunFinish, recordSyncRunPreview, recordSyncRunStart, saveApiRequest,
} from "./db/index.js"
import { addSseClient, broadcast, subscribeToEvents, toBroadcastData } from "./event-broadcaster.js"
import { tryBuildSignerFromEnv } from "./evidence/signer.js"
import { buildLlmClient } from "./llm/registry.js"
import { migrateMemory, prune as pruneMemory } from "./memory/index.js"
import { dispatchNotification } from "./notifications/router.js"
import { AgentOrchestrator } from "./orchestrator/index.js"
import { applyEnvOverrides, seedDefaultPoliciesIfMissing } from "./policy/policy-seeder.js"
import { llmClientAsCompletionPort } from "./proposer/llm-port.js"
import { startScheduler, stopScheduler } from "./proposer/scheduler.js"
import { registerAuthRoutes } from "./routes/auth.js"
import {
    registerAdminRoutes,
    registerAgentRoutes,
    registerApprovalRoutes,
    registerAttachmentRoutes,
    registerBrowserRoutes,
    registerEntityRegistryRoutes,
    registerEventRoutes,
    registerEvidenceRoutes,
    registerLayoutRoutes,
    registerLlmRoutes,
    registerMemoryRoutes,
    registerMetricsRoutes,
    registerMymiRoutes,
    registerNotificationRouteRoutes,
    registerNotificationRoutes,
    registerOperationRoutes,
    registerPolicyRoutes,
    registerProfileRoutes,
    registerProposerRoutes,
    registerRunRoutes,
    registerSyncEnvironmentRoutes,
    registerSyncRoutes,
    registerToolCacheRoutes,
    registerUsageRoutes,
    registerWebhookRoutes,
} from "./routes/index.js"
import { getRunProfile } from "./run-workspace.js"
import { initSandbox } from "./sandbox/index.js"
import { setupMssql } from "./setup-mssql.js"
import { bootstrapEntityRegistryFromYaml } from "./sync/entity-bootstrap.js"
import { installRegistryRecipeResolver } from "./sync/registry-resolver.js"

const PORT = Number(process.env["PORT"] ?? 3102)
const HOST = process.env["HOST"] ?? "0.0.0.0"

async function main() {
  initDatabase()

  let currentWorkspace = resolveWorkspace()
  const sandbox = await configureSandbox(() => currentWorkspace)
  const mssqlSummary = setupMssql(_projectRoot)

  // Bridge agent-side attachment tools to the server's repo + sandbox.
  // Installed once on the root runtime; per-run runtimes inherit it by
  // reference. The service resolves the active runId / sandboxRoot from
  // HostedPolicyContext at call time, so a single instance is safe for
  // every concurrent run.
  setAttachmentService(serverAttachmentService)

  // Bridge agent-side browse_web tool to per-tenant persistent browser
  // contexts (cookies / localStorage) stored under ~/.mia/browser-contexts/.
  // Anonymous sessions get null and stay ephemeral.
  setBrowserContextProvider(serverBrowserContextProvider)

  // Bridge agent-side browser_auto_login tool to vault-encrypted credentials.
  // Refused for anonymous tenants by the provider itself.
  setBrowserCredentialProvider(serverBrowserCredentialProvider)

  // Bridge agent-side browser_human_handoff tool to the in-process handoff registry.
  setBrowserHandoffProvider(serverBrowserHandoffProvider)

  // ── ABI sync subsystem ──
  await setupEnvironments(_projectRoot)
  // Operator overrides on top of JSON config + seed hosted-default and
  // env-derived policy rules into the DB so the admin UI can show the
  // full active ruleset (and let admins edit it). Done AFTER
  // setupEnvironments so derived rules reflect the merged env config.
  applyEnvOverrides()
  seedDefaultPoliciesIfMissing()
  configurePlanStore(resolve(_projectRoot, "packages/server/data/sync-plans"))
  configureSyncOrchestrator(_projectRoot)
  // Bridge the in-DB entity registry into the orchestrator's recipe
  // lookup path. When an entity has a registry record, the projected
  // recipe wins over the bundled JSON; on miss, the orchestrator falls
  // back to the bundle automatically.
  installRegistryRecipeResolver()
  // Bootstrap: import seed YAMLs from deploy/mssql/entities/ into the
  // `_default` tenant on first boot (idempotent — files that already
  // exist as registry rows are skipped).
  try {
    const seeded = bootstrapEntityRegistryFromYaml(_projectRoot)
    if (seeded.imported > 0) {
      console.log(`[entity-registry] seeded ${seeded.imported} entity definition(s) from deploy/mssql/entities/`)
    }
  } catch (e) {
    console.warn("[entity-registry] bootstrap from deploy/mssql/entities/ failed:", e instanceof Error ? e.message : e)
  }
  // Fan sync events out via broadcast(): SSE for live UI, event_log table
  // for replay & webhook drains. See orchestrator.ts → "Event sink" comment
  // for the full list of emitted event types.
  setSyncEventSink((ev) => broadcast({ type: ev.type, data: ev.data }))
  // Persist every executeSync() invocation as a SyncRun row in SQLite for
  // the audit trail / "active syncs" dashboard / drift forensics.
  setSyncRunSink({
    start: (i) => {
      try { recordSyncRunStart(i) } catch (e) { console.warn("[sync] recordSyncRunStart failed:", e) }
    },
    finish: (i) => {
      try { recordSyncRunFinish(i) } catch (e) { console.warn("[sync] recordSyncRunFinish failed:", e) }
    },
    // Durable plan-body persistence — survives restarts so the History modal
    // can re-hydrate the diff for any past sync run (UI- or agent-initiated).
    savePlan: (plan) => {
      try {
        recordSyncRunPreview({
          planId: plan.planId,
          entityType: plan.recipeSnapshot.entityType,
          entityId: plan.entity.id,
          entityDisplayName: plan.entity.displayName,
          source: plan.source,
          target: plan.target,
          actorUpn: null, // not known here; recordSyncRunStart sets it on execute
          previewTotals: plan.totals,
          planJson: JSON.stringify(plan),
        })
      } catch (e) { console.warn("[sync] recordSyncRunPreview failed:", e) }
    },
    loadPlan: (planId) => {
      try {
        const json = getSyncRunPlanJson(planId)
        return json ? JSON.parse(json) : null
      } catch (e) { console.warn("[sync] getSyncRunPlanJson failed:", e); return null }
    },
  })

  const llm = await buildLlmAndCatalog(mssqlSummary)

  // ── F1 evidence signer ────────────────────────────────────────
  // Built once at boot. If the operator has not configured a signer
  // (no env vars set), `tryBuildSignerFromEnv` returns `ok: false` and
  // evidence sealing routes will fail with a clear error — better than
  // silently writing unsigned envelopes.
  const evidenceStorageRoot = resolve(_projectRoot, "packages/server/data/evidence")
  const signerResult = tryBuildSignerFromEnv()
  if (!signerResult.ok) {
    console.warn(`[evidence] signer not configured (kind=${signerResult.error.kind}): ${signerResult.error.message}`)
  } else {
    console.log(`[evidence] signer ready: ${signerResult.signer.id} (${signerResult.signer.alg})`)
  }
  const evidenceSigner = signerResult.ok ? signerResult.signer : null

  // ── F1 proposer scheduler ─────────────────────────────────────
  // Build the proposer LLM port from the active LLM client and start
  // the cron-style scheduler. The port is rebuilt on hot-swap via
  // `registerLlmRoutes` below (kept in a holder so the running
  // scheduler picks up the new client).
  const llmPortHolder = { current: llmClientAsCompletionPort(llm) }
  startScheduler({ llm: () => llmPortHolder.current })
  // Graceful shutdown — drain in-flight proposer runs before exit.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void stopScheduler(60_000).finally(() => process.exit(0))
    })
  }

  // ── F1 notification fan-out ───────────────────────────────────
  // Every event broadcast through `broadcast()` is also offered to the
  // notification router; the router will only act when a matching
  // `notification_routes` row exists for the tenant+eventType.
  subscribeToEvents((ev) => {
    try {
      const data = (ev.data ?? {}) as Record<string, unknown>
      const tenantId = (typeof data["tenantId"] === "string" ? data["tenantId"] : null) ?? "_default"
      dispatchNotification({
        tenantId,
        eventType:  ev.type,
        riskTier:   typeof data["riskTier"]   === "string" ? data["riskTier"]   as string : undefined,
        envPair:    typeof data["envPair"]    === "string" ? data["envPair"]    as string : undefined,
        entityType: typeof data["entityType"] === "string" ? data["entityType"] as string : undefined,
        context:    { ...data, eventType: ev.type },
      })
    } catch (e) {
      // never let notification dispatch take down the broadcaster
      console.warn("[notifications] dispatch failed:", e instanceof Error ? e.message : e)
    }
  })

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
    evidenceStorageRoot,
    evidenceSigner,
    llmPortHolder,
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
  console.log(`Database initialized (${getDbPath()})`)

  // Heal any legacy runs.status values that don't match the canonical
  // RunStatus enum. Without this, rows written before the enum guard
  // existed (e.g. the short-lived 'queued' state) would render as
  // perpetually in-flight in every widget that reads the column.
  const normalised = normaliseUnknownRunStatuses()
  if (normalised > 0) {
    console.log(`Normalised ${normalised} runs with unknown legacy statuses to 'failed'`)
  }

  const pruneResult = pruneOldData()
  if (pruneResult.prunedRuns > 0 || pruneResult.prunedApiRequests > 0) {
    console.log(`Pruned ${pruneResult.prunedRuns} old runs, ${pruneResult.prunedApiRequests} API request logs`)
  }

  const attachmentPrune = pruneExpiredAttachments()
  if (attachmentPrune.prunedAttachments > 0) {
    console.log(`Pruned ${attachmentPrune.prunedAttachments} expired attachments (retention TTL)`)
  }

  const memPrune = pruneMemory()
  if (memPrune.deleted > 0) {
    console.log(`Pruned ${memPrune.deleted} stale/duplicate memory entries`)
  }

  // v19: seed bootstrap admin from env if the users table is empty. This
  // is the only way to get the first admin into the system after the v19
  // schema reset (the legacy MIA_ADMIN_UPNS whitelist no longer exists).
  bootstrapAdminFromEnv()
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
      const baseCachePath = process.env.CATALOG_CACHE_PATH || "./data/catalog-cache.json"
      const lineagePath = process.env.LINEAGE_FILE || resolve(_projectRoot, "deploy/mssql/lineage.json")

      // Build catalog per configured connection so the Mymi DB explorer
      // (and any catalog-backed tool) works against the actual DB the user picks.
      // Cache file name is derived from the connection name to avoid collisions.
      const configs = getMssqlConfig()
      const conns = configs.length > 0 ? configs.map((c) => c.name) : ["default"]

      for (const conn of conns) {
        const cachePath = conns.length === 1
          ? baseCachePath
          : baseCachePath.replace(/\.json$/i, `.${conn}.json`)
        console.log(`Loading schema catalog for "${conn}" (cache: ${cachePath}, max age: ${maxAgeHours}h)...`)
        try {
          const catalog = await buildCatalog({ connection: conn, cachePath, maxAgeMs: maxAgeHours * 3600_000 })
          const s = catalog.stats()
          const ageH = Math.round((Date.now() - catalog.builtAt.getTime()) / 3600000)
          const source = ageH < 1 ? "built fresh from MSSQL" : `loaded from cache (${ageH}h old)`
          console.log(`Catalog [${conn}] ${source}: ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs`)

          try {
            const count = await loadLineage(lineagePath, conn)
            console.log(`Lineage maps loaded for [${conn}]: ${count} critical view(s)`)
          } catch {
            // Non-fatal — lineage file may not exist
          }
        } catch (e) {
          console.warn(`Failed to build catalog for "${conn}":`, e instanceof Error ? e.message : e)
        }
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
  // F1 — evidence + proposer wiring built at boot, threaded into routes.
  evidenceStorageRoot: string
  evidenceSigner: import("./evidence/signer.js").Signer | null
  llmPortHolder: { current: import("@mia/agent").LlmCompletionPort }
}

async function buildApp(opts: AppOpts) {
  const { orchestrator, messageQueue, messageRouter, uiDist, getWorkspace, setWorkspace,
          evidenceStorageRoot, evidenceSigner, llmPortHolder } = opts

  // trustProxy: when behind a corporate HTTPS terminator (proxy-https, IIS,
  // nginx) Fastify needs to honour X-Forwarded-* headers so req.ip reflects
  // the real client and Secure cookies survive the hop.
  const app = Fastify({ logger: false, trustProxy: true })
  await app.register(cors, { origin: true, credentials: true })
  await app.register(cookie, { secret: process.env["MIA_COOKIE_SECRET"] ?? undefined })

  // Identity middleware — resolves req.session and seeds AsyncLocalStorage.
  // Must be registered AFTER @fastify/cookie. Adds GET /api/auth/whoami,
  // POST /api/auth/logout, and the 401 gate for everything outside the
  // auth bypass list.
  await registerIdentity(app)
  // Auth routes (register/login/config) — paths are on the bypass list in
  // identity.ts so they're reachable without a session.
  await registerAuthRoutes(app)

  app.addHook("onRequest", (req, _reply, done) => {
    ;(req as any)._startTime = Date.now()
    done()
  })
  app.addHook("onResponse", (req, reply, done) => {
    if (req.url.startsWith("/api/events/stream") || req.url.endsWith("/stream") || (!req.url.startsWith("/api") && !req.url.startsWith("/webhooks"))) {
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
      broadcast({ type: EventType.ApiRequest, data: toBroadcastData(entry) })
    } catch { /* don't break responses if logging fails */ }
    // Multi-user observability: stamp user identity on console for ops greppability.
    // Skip auth/whoami polling noise + admin observability endpoints.
    if (!req.url.startsWith("/api/auth/whoami") && !req.url.startsWith("/api/admin/sessions") && !req.url.startsWith("/api/admin/active-runs") && !req.url.startsWith("/api/admin/users")) {
      const s = (req as { session?: { upn?: string; displayName?: string; sid?: string } }).session
      const who = s?.upn ?? s?.displayName ?? s?.sid?.slice(0, 12) ?? "—"
      console.log(`[${who}] ${req.method} ${req.url} → ${reply.statusCode} (${duration}ms)`)
    }
    done()
  })

  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: "/", wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/webhooks")) {
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

  // Server-Sent Events — the single real-time transport. The platform used
  // to also expose `GET /ws` (WebSocket), but the UI only ever consumed SSE
  // and there was zero client→server traffic over the WS channel, so it was
  // removed in favour of one transport. SSE is also more proxy-friendly
  // (works through HTTP-only reverse proxies that drop Upgrade frames) and
  // browsers handle reconnect automatically via EventSource.
  app.get("/api/events/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    // Disable Nagle's algorithm so each SSE frame is sent immediately
    // instead of being coalesced with subsequent writes into one TCP packet.
    reply.raw.socket?.setNoDelay(true)
    // identity.ts:resolveSession() runs in onRequest BEFORE this handler and
    // guarantees req.session is populated with a non-empty sid (header path,
    // signed cookie, or `anon:<random>` minted on first contact). No defensive
    // fallbacks here — a missing session would indicate the identity hook is
    // broken and we want that to surface loudly, not be masked by "anon".
    const dispose = addSseClient(reply.raw, {
      upn:     req.session.upn,
      sid:     req.session.sid,
      isAdmin: req.session.isAdmin,
    })
    // Heartbeat every 25s — keeps intermediaries from idle-closing the stream.
    const heartbeat = setInterval(() => {
      try { reply.raw.write(`: ping\n\n`) } catch { /* dropped */ }
    }, 25_000)
    req.raw.on("close", () => { clearInterval(heartbeat); dispose() })
  })

  registerRunRoutes(app, orchestrator)
  registerAgentRoutes(app, orchestrator)
  registerBrowserRoutes(app)
  registerLayoutRoutes(app)
  registerPolicyRoutes(app)
  registerSyncEnvironmentRoutes(app)
  registerProfileRoutes(app)
  registerAttachmentRoutes(app)
  registerUsageRoutes(app)
  registerMymiRoutes(app)
  registerSyncRoutes(app, _projectRoot)
  registerEntityRegistryRoutes(app)
  registerToolCacheRoutes(app)
  registerEventRoutes(app)
  registerOperationRoutes(app)
  registerWebhookRoutes(app, messageRouter, messageQueue)
  registerNotificationRoutes(app, orchestrator)
  registerMemoryRoutes(app, orchestrator)
  registerLlmRoutes(app, (newClient) => {
    orchestrator.setLlm(newClient)
    llmPortHolder.current = llmClientAsCompletionPort(newClient)
    console.log("LLM client hot-swapped")
  })
  // F1 — reconciliation proposer + approvals + evidence + metrics + notification routes
  registerProposerRoutes(app, { getLlm: () => llmPortHolder.current })
  registerApprovalRoutes(app)
  registerEvidenceRoutes(app, { storageRoot: evidenceStorageRoot, signer: evidenceSigner })
  registerMetricsRoutes(app)
  registerNotificationRouteRoutes(app)
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
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
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

  app.delete("/api/data", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    clearTransactionalData()
    return { ok: true }
  })

  app.get("/api/db/stats", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    return getDbStats()
  })

  app.post<{ Body: { keepRuns?: number; keepApiRequests?: number; keepNotifications?: number } }>(
    "/api/db/prune",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      return { ok: true, ...pruneOldData(req.body ?? {}) }
    },
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
  console.log(`  MI:A COMMAND CENTER`)
  console.log(`${"═".repeat(50)}`)
  console.log(`  Server:    http://localhost:${PORT}`)
  console.log(`  Events:    http://localhost:${PORT}/api/events/stream  (SSE)`)
  console.log(`  API:       http://localhost:${PORT}/api`)
  console.log(`  Teams:     ${uiExists ? `https://<host>/webhooks/teams` : `http://localhost:${PORT}/webhooks/teams`}`)
  console.log(`  Dashboard: ${uiExists ? `http://localhost:${PORT}` : "http://localhost:5179 (dev)"}`)
  console.log(`  Channels:  ${channelConfigs.length > 0 ? channelConfigs.map(c => c.type).join(", ") : "none (configure via POST /api/channels)"}`)
  console.log(`  MSSQL:     ${mssqlSummary}`)
  // Profile is the single rollout switch (AGENT_HOSTED_MODE). Surfacing it
  // on the banner makes it impossible to operate a deployment in the wrong
  // mode by accident.
  const profile = getRunProfile()
  console.log(`  Profile:   ${profile === "hosted" ? "HOSTED (sandbox-only, attachments mandatory)" : "developer (legacy local mode)"}`)
  console.log(`${"═".repeat(50)}\n`)
}

main().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})
