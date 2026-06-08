/**
 * Browser-feature transport routes.
 */

import type { FastifyInstance } from "fastify"
import { listAuditLog } from "../adapters/browser/audit.js"
import { listContexts } from "../adapters/browser/context-store.js"
import {
  createCredential,
  deleteCredential,
  listCredentials,
  type CredentialKind
} from "../adapters/browser/credentials.js"
import {
  awaitHandoff,
  completeHandoff,
  getHandoff,
  listHandoffs,
  mintHandoff,
  revokeHandoff
} from "../adapters/browser/handoff.js"
import { addPolicyRule, deletePolicyRule, listPolicyRules } from "../adapters/browser/policy.js"
import { deleteProxyConfig, getProxyConfig, setProxyConfig } from "../adapters/browser/proxy.js"
import { HandoffStatus } from "../enums/browser.js"

function requireUpn(
  req: { session: { upn: string | null } },
  reply: { code: (n: number) => unknown }
): string | null {
  const upn = req.session?.upn
  if (!upn) {
    reply.code(401)
    return null
  }
  return upn
}

export function registerBrowserRoutes(app: FastifyInstance): void {
  app.get("/api/browser/credentials", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    return { credentials: listCredentials(upn) }
  })

  app.post<{ Body: { label?: string; kind?: CredentialKind; target_origin?: string; payload?: unknown } }>(
    "/api/browser/credentials",
    async (req, reply) => {
      const upn = requireUpn(req, reply)
      if (!upn) return { error: "auth required" }
      const { label, kind, target_origin, payload } = req.body ?? {}
      if (!label || !kind || !target_origin || !payload) {
        reply.code(400)
        return { error: "label, kind, target_origin and payload are required" }
      }
      if (kind !== "password" && kind !== "totp" && kind !== "cookie_jar") {
        reply.code(400)
        return { error: "kind must be password|totp|cookie_jar" }
      }
      try {
        const meta = createCredential({
          ownerUpn: upn,
          label,
          kind,
          targetOrigin: target_origin,
          payload
        })
        return { credential: meta }
      } catch (error) {
        reply.code(400)
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  app.delete<{ Params: { id: string } }>("/api/browser/credentials/:id", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    const ok = deleteCredential(upn, req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: "not found" }
    }
    return { ok: true }
  })

  app.get("/api/browser/contexts", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    return { contexts: listContexts(upn) }
  })

  app.get("/api/browser/proxy", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    return { proxy: getProxyConfig(upn) }
  })

  app.put<{ Body: { server?: string; bypass?: string } }>("/api/browser/proxy", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    const { server, bypass } = req.body ?? {}
    if (!server || typeof server !== "string") {
      reply.code(400)
      return { error: "server is required (http(s)://… or socks5://…)" }
    }
    try {
      return { proxy: setProxyConfig({ ownerUpn: upn, server, bypass }) }
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  app.delete("/api/browser/proxy", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    const ok = deleteProxyConfig(upn)
    if (!ok) {
      reply.code(404)
      return { error: "no proxy configured" }
    }
    return { ok: true }
  })

  app.get("/api/browser/handoff", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    return { handoffs: listHandoffs(upn) }
  })

  app.post<{
    Body: { browser_session_id?: string; reason?: "captcha" | "2fa" | "manual"; ttl_ms?: number }
  }>("/api/browser/handoff", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    const { browser_session_id, reason, ttl_ms } = req.body ?? {}
    if (!browser_session_id) {
      reply.code(400)
      return { error: "browser_session_id required" }
    }
    const rec = mintHandoff({
      ownerUpn: upn,
      browserSessionId: browser_session_id,
      reason: reason ?? "manual",
      ...(ttl_ms ? { ttlMs: ttl_ms } : {})
    })
    return { handoff: rec }
  })

  app.post<{ Params: { id: string } }>("/api/browser/handoff/:id/complete", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    const ok = completeHandoff(upn, req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: "not found or already resolved" }
    }
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>("/api/browser/handoff/:id", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    const ok = revokeHandoff(upn, req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: "not found or already resolved" }
    }
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>("/api/browser/handoff/:id/await", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    const rec = getHandoff(upn, req.params.id)
    if (!rec) {
      reply.code(404)
      return { error: "not found" }
    }
    if (rec.status !== HandoffStatus.Pending) return { handoff: rec }
    const final = await awaitHandoff(req.params.id)
    return { handoff: final }
  })

  app.get("/api/browser/policy", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    return { rules: listPolicyRules(upn) }
  })

  app.post<{ Body: { pattern?: string; effect?: "allow" | "deny"; reason?: string; global?: boolean } }>(
    "/api/browser/policy",
    async (req, reply) => {
      const upn = requireUpn(req, reply)
      if (!upn) return { error: "auth required" }
      const { pattern, effect, reason, global } = req.body ?? {}
      if (!pattern || (effect !== "allow" && effect !== "deny")) {
        reply.code(400)
        return { error: "pattern and effect (allow|deny) required" }
      }
      if (global && !req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only for global rules" }
      }
      const rule = addPolicyRule({
        ownerUpn: global ? null : upn,
        pattern,
        effect,
        ...(reason ? { reason } : {})
      })
      return { rule }
    }
  )

  app.delete<{ Params: { id: string } }>("/api/browser/policy/:id", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    if (!req.session?.isAdmin) {
      const rules = listPolicyRules(upn)
      const own = rules.find((rule) => rule.id === req.params.id && rule.ownerUpn === upn)
      if (!own) {
        reply.code(404)
        return { error: "not found" }
      }
    }
    const ok = deletePolicyRule(req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: "not found" }
    }
    return { ok: true }
  })

  app.get<{ Querystring: { limit?: string } }>("/api/browser/audit", async (req, reply) => {
    const upn = requireUpn(req, reply)
    if (!upn) return { error: "auth required" }
    const limit = req.query?.limit ? Number(req.query.limit) : undefined
    return { entries: listAuditLog({ ownerUpn: upn, ...(limit ? { limit } : {}) }) }
  })
}
