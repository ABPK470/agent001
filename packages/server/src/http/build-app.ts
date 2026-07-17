/**
 * HTTP application — Fastify composition root.
 */

import cookie from "@fastify/cookie"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import { EventType, type AgentHost } from "@mia/agent"
import Fastify from "fastify"
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { registerConnectorRoutes } from "../features/connectors/transport/connectors.js"
import { registerBridgeRoutes } from "../features/connectors/transport/bridge.js"
import { registerAdminRoutes } from "../features/admin/routes.js"
import { registerAgentRoutes } from "../features/agents/routes.js"
import { registerApprovalRoutes } from "../features/approvals/routes.js"
import { registerAttachmentRoutes } from "../features/attachments/routes.js"
import { registerAuthRoutes, registerIdentity } from "../features/auth/index.js"
import { registerEventRoutes } from "../features/events/routes.js"
import { registerEvidenceRoutes } from "../features/evidence/routes.js"
import { registerLayoutRoutes } from "../features/layouts/routes.js"
import { registerLlmRoutes } from "../features/llm/routes.js"
import { registerMemoryRoutes } from "../features/memory/routes.js"
import { registerMetricsRoutes } from "../features/metrics/routes.js"
import { registerMymiRoutes } from "../features/mymi/routes.js"
import { registerNotificationManagementRoutes } from "../features/notifications/transport/management-routes.js"
import { registerNotificationRoutes } from "../features/notifications/routes.js"
import { registerOperationRoutes } from "../features/operations/routes.js"
import { registerPlatformRoutes } from "../features/platform/routes.js"
import { registerPolicyRoutes } from "../features/policies/routes.js"
import { registerProfileRoutes } from "../features/profile/routes.js"
import { registerProposerRoutes } from "../features/proposer/index.js"
import type { AgentOrchestrator } from "../features/runs/orchestrator.js"
import { registerRunRoutes } from "../features/runs/routes.js"
import {
  registerEntityRegistryRoutes,
  registerFreezeWindowRoutes,
  registerSyncEnvironmentRoutes,
  registerSyncRoutes
} from "../features/sync/index.js"
import { registerThreadRoutes } from "../features/threads/index.js"
import { registerToolCacheRoutes } from "../features/tool-cache/routes.js"
import { registerUsageRoutes } from "../features/usage/routes.js"
import { registerWebhookRoutes } from "../features/webhooks/routes.js"
import { addSseClient, broadcast, toBroadcastData } from "../platform/events/broadcaster.js"
import { createLlmCompletionAdapter } from "../platform/llm/index.js"
import {
  clearTransactionalData,
  getDbStats,
  pruneOldData,
  saveApiRequest
} from "../platform/persistence/index.js"
import type { Signer } from "../platform/persistence/evidence.js"
import { touchSession } from "../platform/persistence/sessions.js"
import type { MessageQueue, MessageRouter } from "../platform/queue/channels/index.js"
import type { LlmCompletionPort } from "@mia/sync"
import type { ServerWorkspaceRef } from "../bootstrap/server-workspace.js"

export interface BuildAppOptions {
  readonly projectRoot: string
  readonly orchestrator: AgentOrchestrator
  readonly messageQueue: MessageQueue
  readonly messageRouter: MessageRouter
  readonly uiDist: string
  readonly workspace: ServerWorkspaceRef
  readonly evidenceStorageRoot: string
  readonly evidenceSigner: Signer | null
  readonly llmPortHolder: { current: LlmCompletionPort }
  readonly bootHost: AgentHost
  readonly mssqlSummary: string
}

export async function buildApp(opts: BuildAppOptions) {
  const {
    projectRoot,
    orchestrator,
    messageQueue,
    messageRouter,
    uiDist,
    workspace,
    evidenceStorageRoot,
    evidenceSigner,
    llmPortHolder,
    bootHost,
    mssqlSummary
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
  registerLayoutRoutes(app)
  registerPolicyRoutes(app)
  registerPlatformRoutes(app, {
    projectRoot,
    mssqlSummary,
    bootHost,
    getWorkspacePath: () => workspace.get(),
    getActiveRunCount: () => orchestrator.getActiveRunIds().length,
    getQueuePending: () => messageQueue.pendingCount,
  })
  registerSyncEnvironmentRoutes(app, bootHost)
  registerConnectorRoutes(app, bootHost)
  registerBridgeRoutes(app, bootHost)
  registerProfileRoutes(app)
  registerAttachmentRoutes(app)
  registerUsageRoutes(app)
  registerMymiRoutes(app, bootHost)
  registerSyncRoutes(app, projectRoot, bootHost)
  registerEntityRegistryRoutes(app, projectRoot)
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

  app.get("/api/workspace", async () => ({ path: workspace.get() }))

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
    workspace.set(resolved)
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
