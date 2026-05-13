/**
 * Identity middleware — resolves the current user for every request.
 *
 * Resolution order:
 *   1. Opportunistic header `From-User-Name` (free win if some intranet
 *      proxy injects it; not required, not configured by us).
 *   2. Signed `mia_sid` cookie (set by the welcome modal via
 *      POST /api/me).
 *   3. Anonymous fallback — assigns a transient sid so the request
 *      still works; client should pop the welcome modal.
 *
 * Auto-admin: any UPN matching MIA_ADMIN_UPNS (comma-separated,
 * case-insensitive) is promoted to admin without further checks. Plus
 * an optional admin password cookie (verified by auth/session.ts) for
 * cases where UPN spoofing is a concern.
 *
 * Every request is then wrapped in AsyncLocalStorage so deep code can
 * call getCurrentSession() without explicit threading.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { touchSession } from "../db/sessions.js"
import { sessionAls, type CurrentSession } from "./context.js"
import { ADMIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SECONDS, newSid, signSession, verifyAdminCookie, verifySession, type SessionPayload } from "./session.js"

declare module "fastify" {
  interface FastifyRequest {
    session: CurrentSession
  }
}

function getAdminUpns(): Set<string> {
  const raw = process.env["MIA_ADMIN_UPNS"] ?? ""
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  )
}

function isAdminUpn(upn: string | null): boolean {
  if (!upn) return false
  return getAdminUpns().has(upn.toLowerCase())
}

function readHeaderUpn(req: FastifyRequest): string | null {
  // Various corp proxies use slightly different header names. Accept the
  // common ones; first non-empty wins.
  const candidates = ["from-user-name", "x-user-name", "x-forwarded-user", "x-remote-user"]
  for (const h of candidates) {
    const v = req.headers[h]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return null
}

function readHeaderDisplayName(req: FastifyRequest): string | null {
  const first = req.headers["from-first-name"]
  const last = req.headers["from-last-name"]
  if (typeof first === "string" && typeof last === "string") {
    const combined = `${first} ${last}`.trim()
    if (combined) return combined
  }
  return null
}

function resolveSession(req: FastifyRequest): CurrentSession {
  // 1. Header path (proxy-injected identity)
  const headerUpn = readHeaderUpn(req)
  if (headerUpn) {
    return {
      sid: `header:${headerUpn.toLowerCase()}`,
      displayName: readHeaderDisplayName(req) ?? headerUpn,
      upn: headerUpn,
      isAdmin: isAdminUpn(headerUpn) || verifyAdminCookie(req.cookies?.[ADMIN_COOKIE]),
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? ""),
    }
  }

  // 2. Cookie path (welcome-modal payload)
  const cookieRaw = req.cookies?.[SESSION_COOKIE]
  const payload = verifySession(cookieRaw)
  if (payload) {
    return {
      sid: payload.sid,
      displayName: payload.displayName,
      upn: payload.upn,
      // isAdmin baked at login takes priority; fall back to live UPN check and admin cookie
      isAdmin: payload.isAdmin === true || isAdminUpn(payload.upn) || verifyAdminCookie(req.cookies?.[ADMIN_COOKIE]),
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? ""),
    }
  }

  // 3. Anonymous fallback — transient sid (not persisted to cookie until
  // the welcome modal posts /api/me). Client should pop the modal.
  return {
    sid: `anon:${newSid()}`,
    displayName: "Anonymous",
    upn: null,
    isAdmin: verifyAdminCookie(req.cookies?.[ADMIN_COOKIE]),
    ip: req.ip,
    userAgent: String(req.headers["user-agent"] ?? ""),
  }
}

/**
 * Register the identity hook + /api/me endpoints.
 * Must be called AFTER @fastify/cookie is registered.
 */
export async function registerIdentity(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const session = resolveSession(req)
    req.session = session
    // Sticky anonymous identity. If we just created a transient anon sid
    // (no header, no cookie), persist it as a signed session cookie so that
    // every subsequent request from this browser carries the SAME sid.
    // Without this, every request gets a fresh `anon:${random}` and the SSE
    // socket / run owner stamp end up with different sids → broadcast filter
    // drops every event for the user, chat sticks on "Thinking" forever.
    if (session.sid.startsWith("anon:") && !req.cookies?.[SESSION_COOKIE]) {
      const payload: SessionPayload = {
        sid: session.sid,
        displayName: session.displayName,
        upn: null,
        createdAt: Date.now(),
      }
      try {
        reply.setCookie(SESSION_COOKIE, signSession(payload), {
          httpOnly: true,
          sameSite: "lax",
          secure:   process.env["NODE_ENV"] === "production",
          path:     "/",
          maxAge:   SESSION_TTL_SECONDS,
        })
      } catch { /* SSE responses already streamed headers — best-effort */ }
    }
    // enterWith persists the ALS store for the rest of this async chain
    // (handlers, db calls, tool calls) so getCurrentSession() works downstream.
    sessionAls.enterWith({ session })
    // Bump last-seen for the admin Active Users widget. Cheap upsert; skipped
    // for transient anonymous sids (handled inside touchSession).
    try { touchSession(session) } catch { /* don't break requests on logging */ }
  })

  // GET /api/me — what the SPA needs to render
  app.get("/api/me", async (req) => {
    return {
      sessionId:   req.session.sid,
      displayName: req.session.displayName,
      upn:         req.session.upn,
      isAdmin:     req.session.isAdmin,
    }
  })

  // POST /api/me — welcome modal submits { displayName, upn } to set the cookie
  app.post<{ Body: { displayName?: string; upn?: string } }>("/api/me", async (req, reply) => {
    const rawName = (req.body?.displayName ?? "").trim()
    const upn = (req.body?.upn ?? "").trim()
    if (!rawName) {
      reply.code(400)
      return { error: "displayName is required" }
    }
    if (upn && /\s/.test(upn)) {
      reply.code(400)
      return { error: "upn must not contain whitespace" }
    }
    const displayName = rawName
    // Reuse existing stable sid if the browser already has one — avoids
    // creating a fresh orphan session row every time the modal is submitted
    // from the same browser (e.g. new tab, page reload before cookie expires).
    const existingCookie = req.cookies?.[SESSION_COOKIE]
    const existingPayload = existingCookie ? verifySession(existingCookie) : null
    const sid = (existingPayload && !existingPayload.sid.startsWith("anon:"))
      ? existingPayload.sid
      : newSid()
    const isAdmin = isAdminUpn(upn || null) || verifyAdminCookie(req.cookies?.[ADMIN_COOKIE])
    const payload: SessionPayload = {
      sid,
      displayName,
      // Admin access codes are a pure auth gate — don't bake them into identity as a UPN.
      // This way changing MIA_ADMIN_UPNS never creates a new identity / fragments session history.
      upn: isAdmin && isAdminUpn(upn || null) ? null : (upn || null),
      isAdmin,
      createdAt: existingPayload?.createdAt ?? Date.now(),
    }
    const value = signSession(payload)
    reply.setCookie(SESSION_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      secure:   process.env["NODE_ENV"] === "production",
      path:     "/",
      maxAge:   SESSION_TTL_SECONDS,
    })
    return {
      sessionId:   payload.sid,
      displayName: payload.displayName,
      upn:         payload.upn,
      isAdmin:     isAdmin,
    }
  })

  // POST /api/me/clear — "Switch user" button
  app.post("/api/me/clear", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" })
    return { ok: true }
  })
}
