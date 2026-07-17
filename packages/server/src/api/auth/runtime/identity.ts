/**
 * Identity middleware (v19) — accounts-based.
 *
 * Every request resolves to a real, verified user backed by the
 * `users` table OR is rejected with 401. There are exactly two
 * authentication paths:
 *
 *   1. SSO header (proxy-injected): From-User-Name / X-User-Name /
 *      X-Forwarded-User / X-Remote-User. Trusted because the deployment
 *      contract is "the proxy authenticated this user". On first sight,
 *      a `users` row is created (source='sso'), then a normal session
 *      is minted exactly as for local login. Subsequent requests from
 *      the same browser carry the session cookie.
 *
 *   2. Local password (POST /api/auth/login): username/password verified
 *      via auth/users.ts; on success a sessions row is inserted and the
 *      sid is HMAC-signed into the cookie.
 *
 * Auth-bypass paths are listed in AUTH_BYPASS_PATHS — only login,
 * register, the health probe, and static assets are reachable without
 * a session.
 *
 * Anonymous identity, the welcome modal, the admin login modal, the
 * `MIA_ADMIN_UPNS` whitelist, and the `mia_admin` cookie are ALL gone
 * in this version. Admin status is a column on the users row.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { createSession, deleteSession, getSessionWithUser } from "../../../infra/persistence/sessions.js"
import { upsertSsoUser } from "../application/users.js"
import type { CurrentSession } from "./context.js"
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSid, verifySid } from "./session.js"

declare module "fastify" {
  interface FastifyRequest {
    session: CurrentSession
  }
}

/**
 * Path prefixes that bypass the 401 gate. Everything not listed here
 * requires a logged-in session.
 *
 * Health probes and the auth endpoints themselves obviously cannot
 * require auth. Static asset paths are served by @fastify/static AFTER
 * the request hook runs, so we whitelist their prefix here too — the
 * SPA itself must load before the user can log in.
 */
const AUTH_BYPASS_PATHS = [
  "/api/auth/", // register / login / logout / whoami
  "/api/health"
] as const

const STATIC_BYPASS_PREFIXES = [
  "/assets/",
  "/favicon",
  "/index.html",
  "/login", // SPA route
  "/manifest",
  "/robots.txt"
] as const

function pathIsAuthExempt(url: string): boolean {
  // url may include query string
  const path = url.split("?")[0]
  if (path === "/") return true
  if (AUTH_BYPASS_PATHS.some((p) => path.startsWith(p))) return true
  if (STATIC_BYPASS_PREFIXES.some((p) => path.startsWith(p))) return true
  return false
}

function readHeaderUpn(req: FastifyRequest): string | null {
  // Various corp proxies use slightly different header names. First
  // non-empty wins. We only honour SSO headers if they were not present
  // BUT the existing session is anonymous — i.e., the very first request
  // from this browser. After login, the cookie sid takes precedence
  // regardless of headers.
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

function setSessionCookie(reply: FastifyReply, sid: string): void {
  reply.setCookie(SESSION_COOKIE, signSid(sid), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  })
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" })
}

/**
 * Try to materialise a session from the cookie or an SSO header. Returns
 * the session on success; null on failure (caller decides 401 vs bypass).
 */
function tryResolveSession(req: FastifyRequest, reply: FastifyReply): CurrentSession | null {
  const ip = req.ip
  const userAgent = String(req.headers["user-agent"] ?? "")

  // 1. Existing cookie path — JOIN users and return.
  const sid = verifySid(req.cookies?.[SESSION_COOKIE])
  if (sid) {
    const row = getSessionWithUser(sid)
    if (row) {
      // NOTE: we intentionally do NOT call touchSession() here. Bumping
      // last_seen_at on every HTTP request would mark every open tab as
      // "online" forever (background widgets poll, SSE keepalives fire,
      // etc.). Instead liveness is driven by the SSE stream lifecycle:
      // index.ts touches the session while /api/events/stream is
      // connected and stops touching when the client disconnects, so
      // `last_seen_at` ages out within the 60 s window naturally. No
      // polling endpoint, no extra request noise in the logs.
      return {
        sid: row.sid,
        upn: row.upn,
        displayName: row.display_name,
        isAdmin: row.is_admin === 1,
        ip,
        userAgent
      }
    }
    // Cookie was signed by us but no DB row matches — likely revoked
    // (DELETE FROM sessions) or the DB was reset. Clear so the SPA stops
    // re-presenting the dead cookie on every request.
    try {
      clearSessionCookie(reply)
    } catch {
      /* SSE may have flushed headers */
    }
  }

  // 2. SSO header path — trusted if the deployment configured a proxy
  // to inject these headers. Auto-provisions a user row on first sight,
  // then immediately mints a session so subsequent requests work via
  // the cookie path above (no need to re-trust headers every time).
  const headerUpn = readHeaderUpn(req)
  if (headerUpn) {
    const user = upsertSsoUser({
      upn: headerUpn,
      displayName: readHeaderDisplayName(req) ?? headerUpn
    })
    const newSid = createSession({ upn: user.upn, ip, userAgent })
    try {
      setSessionCookie(reply, newSid)
    } catch {
      /* SSE-first request — cookie set on next request */
    }
    return {
      sid: newSid,
      upn: user.upn,
      displayName: user.display_name,
      isAdmin: user.is_admin === 1,
      ip,
      userAgent
    }
  }

  return null
}

/**
 * Register the identity hook. Must be called AFTER @fastify/cookie is
 * registered and AFTER routes/auth.ts has been registered (so its paths
 * exist on the bypass list). The auth routes themselves do not enforce
 * the gate — see pathIsAuthExempt.
 */
export async function registerIdentity(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // HEAD requests and explicit health probes never carry cookies and
    // never need identity. We don't touch the DB for them.
    const isProbe = req.method === "HEAD" || req.url === "/api/health" || req.url.startsWith("/api/health?")
    if (isProbe) return

    const session = tryResolveSession(req, reply)
    if (session) {
      req.session = session
      return
    }

    // No session AND not on the bypass list → 401. The SPA's fetch
    // wrapper interprets 401 as "redirect to /login".
    if (!pathIsAuthExempt(req.url)) {
      reply.code(401).send({ error: "authentication required" })
      return reply
    }
    // Bypass path with no session — leave req.session unset; handler
    // must not assume a session.
  })

  // GET /api/auth/whoami — what the SPA needs to render the shell.
  app.get("/api/auth/whoami", async (req, reply) => {
    if (!req.session) {
      reply.code(401)
      return { error: "not logged in" }
    }
    return {
      upn: req.session.upn,
      displayName: req.session.displayName,
      isAdmin: req.session.isAdmin
    }
  })

  // POST /api/auth/logout — delete the server-side row + clear cookie.
  app.post("/api/auth/logout", async (req, reply) => {
    if (req.session?.sid) {
      try {
        deleteSession(req.session.sid)
      } catch (err) {
        req.log.warn({ err, sid: req.session.sid }, "deleteSession failed")
      }
    }
    clearSessionCookie(reply)
    return { ok: true }
  })
}

/** @internal — exported for routes/auth.ts to mint the cookie after login/register. */
export function loginAndSetCookie(args: {
  reply: FastifyReply
  upn: string
  ip: string
  userAgent: string
}): string {
  const sid = createSession({ upn: args.upn, ip: args.ip, userAgent: args.userAgent })
  setSessionCookie(args.reply, sid)
  return sid
}
