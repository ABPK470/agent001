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
  path: resolve(_projectRoot, ".env")
})

import cookie from "@fastify/cookie"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import {
  EventType,
  buildCatalog,
  closeMssqlPool,
  configureAgent,
  getMssqlConfig,
  type AgentHost,
  type BrowserClient,
  type ShellClient
} from "@mia/agent"
import { configurePlanStore } from "@mia/sync"
import Fastify from "fastify"
import { createSyncEventSink, createSyncRunSink } from "./bootstrap/sync.js"
import { getRunProfile } from "./bootstrap/workspace.js"
import { registerAdminRoutes } from "./features/admin/routes.js"
import { registerAgentRoutes } from "./features/agents/routes.js"
import { registerApprovalRoutes } from "./features/approvals/routes.js"
import { registerAttachmentRoutes } from "./features/attachments/routes.js"
import { bootstrapAdminFromEnv, registerAuthRoutes, registerIdentity } from "./features/auth/index.js"
import { buildBrowserScript, formatBrowserReport } from "./features/browser/application/helpers.js"
import { registerBrowserRoutes } from "./features/browser/routes.js"
import { serverBrowserCredentialProvider } from "./features/browser/runtime/credential-provider.js"
import { serverBrowserHandoffProvider } from "./features/browser/runtime/handoff-provider.js"
import { serverBrowserContextProvider } from "./features/browser/runtime/provider.js"
import { registerEventRoutes } from "./features/events/routes.js"
import { registerEvidenceRoutes } from "./features/evidence/routes.js"
import { registerLayoutRoutes } from "./features/layouts/routes.js"
import { registerLlmRoutes } from "./features/llm/routes.js"
import { registerMemoryRoutes } from "./features/memory/routes.js"
import { registerMetricsRoutes } from "./features/metrics/routes.js"
import { registerMymiRoutes } from "./features/mymi/routes.js"
import { dispatchNotification } from "./features/notifications/application/delivery-routing.js"
import { registerNotificationRoutes } from "./features/notifications/routes.js"
import { registerNotificationManagementRoutes } from "./features/notifications/transport/management-routes.js"
import { registerOperationRoutes } from "./features/operations/routes.js"
import { seedDefaultPoliciesIfMissing } from "./features/policies/application/policy-seeder.js"
import { registerPolicyRoutes } from "./features/policies/routes.js"
import { registerProfileRoutes } from "./features/profile/routes.js"
import { registerProposerRoutes, startScheduler, stopScheduler } from "./features/proposer/index.js"
import { AgentOrchestrator } from "./features/runs/orchestrator.js"
import { registerRunRoutes } from "./features/runs/routes.js"
import {
  ensureSyncDefinitionConfigs,
  loadPersistedSyncEnvironments,
  registerEntityRegistryRoutes,
  registerFreezeWindowRoutes,
  registerSyncEnvironmentRoutes,
  registerSyncRoutes
} from "./features/sync/index.js"
import { registerThreadRoutes } from "./features/threads/index.js"
import { registerToolCacheRoutes } from "./features/tool-cache/routes.js"
import { registerUsageRoutes } from "./features/usage/routes.js"
import { registerWebhookRoutes } from "./features/webhooks/routes.js"
import { addSseClient, broadcast, subscribeToEvents, toBroadcastData } from "./platform/events/broadcaster.js"
import { createLlmCompletionAdapter } from "./platform/llm/index.js"
import { buildLlmClient } from "./platform/llm/registry.js"
import { setupMssql } from "./platform/mssql/setup.js"
import { pruneExpiredAttachments, serverAttachmentService } from "./platform/persistence/attachments.js"
import {
  clearTransactionalData,
  getDb,
  getDbPath,
  getDbStats,
  getLlmConfig,
  listFreezeWindowDefinitionsForTenant,
  normaliseUnknownRunStatuses,
  pruneOldData,
  saveApiRequest,
  tryBuildSignerFromEnv
} from "./platform/persistence/index.js"
import { prune as pruneMemory } from "./platform/persistence/memory.js"
import { touchSession } from "./platform/persistence/sessions.js"
import {
  MessageQueue,
  MessageRouter,
  SqliteConversationStore,
  SqliteQueueStore,
  TeamsChannel,
  listChannelConfigs
} from "./platform/queue/channels/index.js"
import { initSandbox } from "./platform/sandbox/index.js"

const PORT = Number(process.env["PORT"] ?? 3102)
const HOST = process.env["HOST"] ?? "0.0.0.0"

async function main() {
  initDatabase()

  let currentWorkspace = resolveWorkspace()
  const { sandbox, shellClient, shellSandboxStrict, browserCheckMode, browserCheckClient } =
    await configureSandbox(() => currentWorkspace)

  const mssqlSetup = setupMssql(_projectRoot)
  const syncEnvironments = loadPersistedSyncEnvironments(_projectRoot, mssqlSetup.configs)
  ensureSyncDefinitionConfigs(_projectRoot)
  const syncEventSink = createSyncEventSink()
  const syncRunSink = createSyncRunSink()

  // Shared catalog registry: same Map threaded into the boot host and every
  // per-run host. buildCatalog() populates it; tools read via getCatalog(host).
  const catalogInstances: AgentHost["catalog"]["instances"] = new Map()
  const catalogDefaultCachePath: AgentHost["catalog"]["defaultCachePath"] = { value: undefined }
  const bootHost: AgentHost = configureAgent({
    mssqlConfigs: mssqlSetup.configs,
    mssqlDefaultConnectionName: mssqlSetup.defaultConnectionName,
    catalogInstances,
    catalogDefaultCachePath,
    sync: {
      events: { sink: syncEventSink },
      runs: { sink: syncRunSink, actorUpn: null },
      environments: { items: syncEnvironments.environments },
      project: { dbProjectRoot: _projectRoot },
      governance: { freezeWindowsReader: () => listFreezeWindowDefinitionsForTenant() }
    }
  })
  const mssqlSummary = mssqlSetup.summary

  // Bridge agent-side attachment tools to the server's repo + sandbox.
  // Installed via the AgentHost composition root (see `configureAgent`
  // call below). The service resolves the active runId / sandboxRoot from
  // HostedPolicyContext at call time, so a single instance is safe for
  // every concurrent run.

  // Browse-web persistent-context, credential, and human-handoff backends
  // are wired exclusively via `configureAgent({ browser: { providers } })`
  // below — the legacy
  // `setBrowser*Provider` ambient setters were removed in cluster 7.

  // ── ABI sync subsystem ──
  if (syncEnvironments.source === "db") {
    console.log(`ABI environments (from persisted DB): ${syncEnvironments.summary}`)
  } else if (syncEnvironments.source === "file") {
    console.log(
      `ABI environments seeded from deploy/sync/sync-environments.json: ${syncEnvironments.summary}`
    )
  } else if (syncEnvironments.source === "mssql") {
    console.log(`ABI environments seeded from MSSQL_DATABASES: ${syncEnvironments.summary}`)
  }
  seedDefaultPoliciesIfMissing(bootHost)
  configurePlanStore(bootHost, resolve(_projectRoot, "packages/server/data/sync-plans"))
  const llm = await buildLlmAndCatalog(bootHost, mssqlSummary)

  // ── F1 evidence signer ────────────────────────────────────────
  // Built once at boot. If the operator has not configured a signer
  // (no env vars set), `tryBuildSignerFromEnv` returns `ok: false` and
  // evidence sealing routes will fail with a clear error — better than
  // silently writing unsigned envelopes.
  const evidenceStorageRoot = resolve(_projectRoot, "packages/server/data/evidence")
  const signerResult = tryBuildSignerFromEnv()
  if (!signerResult.ok) {
    console.warn(
      `[evidence] signer not configured (kind=${signerResult.error.kind}): ${signerResult.error.message}`
    )
  } else {
    console.log(`[evidence] signer ready: ${signerResult.signer.id} (${signerResult.signer.alg})`)
  }
  const evidenceSigner = signerResult.ok ? signerResult.signer : null

  // ── F1 proposer scheduler ─────────────────────────────────────
  // Build the proposer LLM port from the active LLM client and start
  // the cron-style scheduler. The port is rebuilt on hot-swap via
  // `registerLlmRoutes` below (kept in a holder so the running
  // scheduler picks up the new client).
  const llmPortHolder = { current: createLlmCompletionAdapter(llm) }
  startScheduler({ host: bootHost, llm: () => llmPortHolder.current })
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
        eventType: ev.type,
        riskTier: typeof data["riskTier"] === "string" ? (data["riskTier"] as string) : undefined,
        envPair: typeof data["envPair"] === "string" ? (data["envPair"] as string) : undefined,
        entityType: typeof data["entityType"] === "string" ? (data["entityType"] as string) : undefined,
        context: { ...data, eventType: ev.type }
      })
    } catch (e) {
      // never let notification dispatch take down the broadcaster
      console.warn("[notifications] dispatch failed:", e instanceof Error ? e.message : e)
    }
  })

  const orchestrator = new AgentOrchestrator({
    llm,
    workspace: currentWorkspace,
    bootHostDeps: {
      attachments: serverAttachmentService,
      browser: {
        providers: {
          contextReader: serverBrowserContextProvider,
          credentialReader: serverBrowserCredentialProvider,
          handoffStore: serverBrowserHandoffProvider
        }
      },
      shell: {
        mode: shellClient ? "sandbox" : "host",
        client: shellClient,
        sandboxStrict: shellSandboxStrict
      },
      browserCheck: {
        mode: browserCheckMode,
        client: browserCheckClient
      },
      mssql: {
        databases: bootHost.mssql.databases,
        defaultConnection: bootHost.mssql.defaultConnection
      },
      catalog: {
        instances: bootHost.catalog.instances,
        defaultCachePath: bootHost.catalog.defaultCachePath
      },
      sync: {
        events: bootHost.sync.events,
        runs: bootHost.sync.runs,
        governance: bootHost.sync.governance,
        environments: bootHost.sync.environments,
        plans: bootHost.sync.plans,
        project: bootHost.sync.project
      }
    }
  })
  const { messageQueue, messageRouter, channelConfigs } = initMessaging(orchestrator)
  const uiDist = resolveUiDist()

  const app = await buildApp({
    orchestrator,
    messageQueue,
    messageRouter,
    uiDist,
    getWorkspace: () => currentWorkspace,
    setWorkspace: (w) => {
      currentWorkspace = w
      applyWorkspace(w, orchestrator)
    },
    evidenceStorageRoot,
    evidenceSigner,
    llmPortHolder,
    bootHost
  })

  await app.listen({ port: PORT, host: HOST })
  recoverStaleRuns(orchestrator)
  printBanner({ mssqlSummary, channelConfigs, uiDist })
  registerShutdown({ sandbox, messageQueue, bootHost })
}

// ── Bootstrap phase functions ─────────────────────────────────

function resolveUiDist(): string {
  return _pkgRoot ? resolve(_pkgRoot, "dist/ui") : resolve(import.meta.dirname, "../../../packages/ui/dist")
}

function applyWorkspace(w: string, orchestrator: AgentOrchestrator): void {
  orchestrator.setWorkspace(w)
}

function recoverStaleRuns(orchestrator: AgentOrchestrator): void {
  const recovery = orchestrator.recoverStaleRuns()
  if (recovery.failed.length > 0) {
    console.log(`Recovered ${recovery.recovered.length} stale runs, ${recovery.failed.length} marked failed`)
  }
}

function registerShutdown({
  sandbox,
  messageQueue,
  bootHost
}: {
  sandbox: ReturnType<typeof initSandbox>
  messageQueue: MessageQueue
  bootHost: AgentHost
}): void {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      messageQueue.stop()
      await closeMssqlPool(bootHost)
      await sandbox.cleanup()
      process.exit(0)
    })
  }
}

function initDatabase(): void {
  getDb()
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
    console.log(
      `Pruned ${pruneResult.prunedRuns} old runs, ${pruneResult.prunedApiRequests} API request logs`
    )
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
  console.log(`Agent workspace: ${workspace}`)
  return workspace
}

async function configureSandbox(getWorkspace: () => string): Promise<{
  sandbox: ReturnType<typeof initSandbox>
  shellClient: ShellClient | null
  shellSandboxStrict: boolean
  browserCheckMode: "host" | "sandbox"
  browserCheckClient: BrowserClient | null
}> {
  const sandboxMode =
    process.env["SANDBOX_MODE"] === "host"
      ? ("host" as const)
      : process.env["SANDBOX_MODE"] === "all"
        ? ("all" as const)
        : ("docker" as const)
  const sandbox = initSandbox({ mode: sandboxMode })
  const dockerReady = await sandbox.isDockerAvailable()

  let shellClient: ShellClient | null = null
  let shellSandboxStrict = false
  let browserCheckMode: "host" | "sandbox" = "host"
  let browserCheckClient: BrowserClient | null = null

  if (dockerReady && sandbox.mode !== "host") {
    shellClient = async (command, cwd, signal) => {
      return sandbox.exec(command, cwd || getWorkspace(), { signal })
    }
    if (sandbox.isStrictMode) {
      shellSandboxStrict = true
      console.log("Docker sandbox: STRICT mode (all commands require Docker, relaxed deny list)")
    } else {
      console.log("Docker sandbox: ACTIVE (commands run in isolated containers)")
    }

    // Build the browser image synchronously at boot. This is one-time on
    // first run (subsequent boots hit the Docker image cache and return
    // in milliseconds). We need the client resolved before constructing
    // the orchestrator so per-run hosts can close over it explicitly
    // (doctrine §1 — no late-bound module setter).
    const browserReady = await sandbox.ensureBrowserImage()
    if (browserReady) {
      browserCheckMode = "sandbox"
      browserCheckClient = async (htmlPath, clicks, waitMs, cwd) => {
        const script = buildBrowserScript(htmlPath, clicks, waitMs)
        const result = await sandbox.browserExec(script, cwd || getWorkspace(), { timeout: 30_000 })
        if (result.stderr === "FALLBACK_TO_HOST") throw new Error("Browser image not available")
        if (result.exitCode !== 0) {
          return {
            report: `Error: ${result.stderr || result.stdout || "Browser check failed in container"}`,
            sandboxed: true
          }
        }
        try {
          return { report: formatBrowserReport(JSON.parse(result.stdout)), sandboxed: true }
        } catch {
          return { report: result.stdout || "(no output)", sandboxed: true }
        }
      }
      console.log("Browser sandbox: ACTIVE (browser_check runs in isolated containers)")
    } else {
      console.log("Browser sandbox: UNAVAILABLE (browser_check runs on host)")
    }
  } else {
    if (sandbox.isStrictMode) {
      console.error("SANDBOX_MODE=all requires Docker but Docker is not available. Aborting.")
      process.exit(1)
    }
    console.log(
      sandbox.mode === "host"
        ? "Docker sandbox: BYPASSED (commands run on host with filtered env)"
        : "Docker sandbox: UNAVAILABLE (commands run on host with filtered env)"
    )
  }

  return { sandbox, shellClient, shellSandboxStrict, browserCheckMode, browserCheckClient }
}

async function buildLlmAndCatalog(host: AgentHost, mssqlSummary: string) {
  const llmCfg = getLlmConfig()
  const llm = buildLlmClient(llmCfg)
  console.log(`LLM: ${llmCfg.provider} / ${llmCfg.model}`)

  if (mssqlSummary !== "not configured") {
    try {
      const maxAgeHours = Number(process.env.CATALOG_MAX_AGE_HOURS || 168)
      const baseCachePath = process.env.CATALOG_CACHE_PATH || "./data/catalog-cache.json"

      // Build catalog per configured connection so the Mymi DB explorer
      // (and any catalog-backed tool) works against the actual DB the user picks.
      // Cache file name is derived from the connection name to avoid collisions.
      const configs = getMssqlConfig(host)
      const conns = configs.length > 0 ? configs.map((c) => c.name) : ["default"]

      for (const conn of conns) {
        const cachePath =
          conns.length === 1 ? baseCachePath : baseCachePath.replace(/\.json$/i, `.${conn}.json`)
        console.log(`Loading schema catalog for "${conn}" (cache: ${cachePath}, max age: ${maxAgeHours}h)...`)
        try {
          const catalog = await buildCatalog(host, {
            connection: conn,
            cachePath,
            maxAgeMs: maxAgeHours * 3600_000
          })
          const s = catalog.stats()
          const ageH = Math.round((Date.now() - catalog.builtAt.getTime()) / 3600000)
          const source = ageH < 1 ? "built fresh from MSSQL" : `loaded from cache (${ageH}h old)`
          console.log(
            `Catalog [${conn}] ${source}: ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs`
          )
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
  const messageRouter = new MessageRouter(messageQueue, conversationStore, {
    startRun: (goal, session, threadId) =>
      orchestrator.startRun(goal, threadId ? { threadId } : undefined, session ?? null)
  })
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
  evidenceSigner: import("./platform/persistence/evidence.js").Signer | null
  llmPortHolder: { current: import("@mia/sync").LlmCompletionPort }
  /** Boot-level AgentHost (shared mssql Map) for routes that hit DB. */
  bootHost: AgentHost
}

async function buildApp(opts: AppOpts) {
  const {
    orchestrator,
    messageQueue,
    messageRouter,
    uiDist,
    getWorkspace,
    setWorkspace,
    evidenceStorageRoot,
    evidenceSigner,
    llmPortHolder,
    bootHost
  } = opts

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
    if (
      req.url.startsWith("/api/events/stream") ||
      req.url.endsWith("/stream") ||
      (!req.url.startsWith("/api") && !req.url.startsWith("/webhooks"))
    ) {
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
      created_at: new Date().toISOString()
    }
    try {
      saveApiRequest(entry)
      broadcast({ type: EventType.ApiRequest, data: toBroadcastData(entry) })
    } catch {
      /* don't break responses if logging fails */
    }
    // Multi-user observability: stamp user identity on console for ops greppability.
    // Skip auth/whoami polling noise + admin observability endpoints.
    if (
      !req.url.startsWith("/api/auth/whoami") &&
      !req.url.startsWith("/api/admin/sessions") &&
      !req.url.startsWith("/api/admin/active-runs") &&
      !req.url.startsWith("/api/admin/users")
    ) {
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
      "X-Accel-Buffering": "no"
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
      upn: req.session.upn,
      sid: req.session.sid,
      isAdmin: req.session.isAdmin
    })

    // ── Liveness ────────────────────────────────────────────────
    // The SSE stream lifecycle IS the online signal. Touch the session
    // immediately on open and every 25 s while connected; when the
    // client disconnects we stop touching, and `last_seen_at` ages out
    // within the 60 s "online" window. No polling endpoint required.
    // Anonymous SSE connections (no real cookie session) carry an
    // `anon:<random>` sid that has no row in `sessions`, so skip them.
    const sid = req.session.sid
    const isRealSession = typeof sid === "string" && !sid.startsWith("anon:")
    if (isRealSession) {
      try {
        touchSession(sid)
      } catch {
        /* observability only */
      }
    }
    // Heartbeat every 25s — keeps intermediaries from idle-closing the
    // stream AND doubles as the liveness ping for the session row.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`)
      } catch {
        /* dropped */
      }
      if (isRealSession) {
        try {
          touchSession(sid)
        } catch {
          /* observability only */
        }
      }
    }, 25_000)
    req.raw.on("close", () => {
      clearInterval(heartbeat)
      dispose()
    })
  })

  registerRunRoutes(app, orchestrator)
  registerThreadRoutes(app, orchestrator)
  registerAgentRoutes(app, orchestrator)
  registerBrowserRoutes(app)
  registerLayoutRoutes(app)
  registerPolicyRoutes(app)
  registerSyncEnvironmentRoutes(app, bootHost)
  registerProfileRoutes(app)
  registerAttachmentRoutes(app)
  registerUsageRoutes(app)
  registerMymiRoutes(app, bootHost)
  registerSyncRoutes(app, _projectRoot, bootHost)
  registerEntityRegistryRoutes(app, _projectRoot)
  registerToolCacheRoutes(app)
  registerEventRoutes(app)
  registerOperationRoutes(app)
  registerWebhookRoutes(app, messageRouter, messageQueue)
  registerNotificationRoutes(app, orchestrator)
  registerMemoryRoutes(app, orchestrator)
  registerLlmRoutes(app, (newClient) => {
    orchestrator.setLlm(newClient)
    llmPortHolder.current = createLlmCompletionAdapter(newClient)
    console.log("LLM client hot-swapped")
  })
  // F1 — reconciliation proposer + approvals + evidence + metrics + notification routes
  registerProposerRoutes(app, { host: bootHost, getLlm: () => llmPortHolder.current })
  registerApprovalRoutes(app)
  registerFreezeWindowRoutes(app)
  registerEvidenceRoutes(app, { storageRoot: evidenceStorageRoot, signer: evidenceSigner })
  registerMetricsRoutes(app)
  registerNotificationManagementRoutes(app)
  registerAdminRoutes(app, orchestrator)

  app.get("/api/health", async () => ({
    status: "ok",
    active: orchestrator.getActiveRunIds().length,
    channels: messageRouter.listChannels(),
    queuePending: messageQueue.pendingCount,
    runQueue: orchestrator.getQueueStats()
  }))

  app.get("/api/workspace", async () => ({ path: getWorkspace() }))

  app.put<{ Body: { path: string } }>("/api/workspace", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
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
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    clearTransactionalData()
    return { ok: true }
  })

  app.get("/api/db/stats", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    return getDbStats()
  })

  app.post<{ Body: { keepRuns?: number; keepApiRequests?: number; keepNotifications?: number } }>(
    "/api/db/prune",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      return { ok: true, ...pruneOldData(req.body ?? {}) }
    }
  )

  // ── Presence tick ────────────────────────────────────────────────
  // A single global timer that fans out one tiny SSE frame to every
  // connected dashboard every 30 s. SSE-driven widgets (e.g. ActiveUsers)
  // listen on `session.*` and re-fetch their aggregates on tick — this
  // is what keeps the "Last seen" / online indicator fresh now that
  // per-request `touchSession()` polling and the heartbeat endpoint are
  // gone. One event per 30 s for the whole server, not per tab.
  const presenceTickHandle = setInterval(() => {
    try {
      broadcast({ type: EventType.SessionPresenceTick, data: {} })
    } catch {
      /* observability only */
    }
  }, 30_000)
  // Don't keep the event loop alive solely for this timer.
  if (typeof presenceTickHandle.unref === "function") presenceTickHandle.unref()
  app.addHook("onClose", async () => {
    clearInterval(presenceTickHandle)
  })

  return app
}

function printBanner({
  mssqlSummary,
  channelConfigs,
  uiDist
}: {
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
  console.log(
    `  Teams:     ${uiExists ? `https://<host>/webhooks/teams` : `http://localhost:${PORT}/webhooks/teams`}`
  )
  console.log(`  Dashboard: ${uiExists ? `http://localhost:${PORT}` : "http://localhost:5179 (dev)"}`)
  console.log(
    `  Channels:  ${channelConfigs.length > 0 ? channelConfigs.map((c) => c.type).join(", ") : "none (configure via POST /api/channels)"}`
  )
  console.log(`  MSSQL:     ${mssqlSummary}`)
  // Profile is the single rollout switch (AGENT_HOSTED_MODE). Surfacing it
  // on the banner makes it impossible to operate a deployment in the wrong
  // mode by accident.
  const profile = getRunProfile()
  console.log(
    `  Profile:   ${profile === "hosted" ? "HOSTED (sandbox-only, attachments mandatory)" : "developer (legacy local mode)"}`
  )
  console.log(`${"═".repeat(50)}\n`)
}

main().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})
