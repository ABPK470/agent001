/**
 * Auth routes — local register / login.
 *
 * Logout + whoami are owned by auth/identity.ts (registered alongside
 * the identity hook because they're tied to its cookie helpers).
 *
 * Registration can be disabled in environments that mandate SSO via the
 * `MIA_ALLOW_LOCAL_REGISTRATION` env var (default: enabled in dev,
 * disabled in production).
 */

import type { FastifyInstance } from "fastify"
import { loginAndSetCookie } from "../auth/identity.js"
import { AuthError, registerLocalUser, verifyLocalLogin } from "../auth/users.js"

function localRegistrationEnabled(): boolean {
  const raw = process.env["MIA_ALLOW_LOCAL_REGISTRATION"]
  if (raw === "1" || raw === "true") return true
  if (raw === "0" || raw === "false") return false
  // Default: enabled outside production.
  return process.env["NODE_ENV"] !== "production"
}

interface RegisterBody {
  username?: string
  password?: string
  displayName?: string
}

interface LoginBody {
  username?: string
  password?: string
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/register — local-account creation.
  app.post<{ Body: RegisterBody }>("/api/auth/register", async (req, reply) => {
    if (!localRegistrationEnabled()) {
      reply.code(403)
      return { error: "local registration is disabled in this deployment" }
    }
    const { username = "", password = "", displayName = "" } = req.body ?? {}
    try {
      const user = registerLocalUser({ username, password, displayName })
      loginAndSetCookie({
        reply,
        upn:       user.upn,
        ip:        req.ip,
        userAgent: String(req.headers["user-agent"] ?? ""),
      })
      reply.code(201)
      return {
        upn:         user.upn,
        displayName: user.display_name,
        isAdmin:     user.is_admin === 1,
      }
    } catch (err) {
      if (err instanceof AuthError) {
        reply.code(err.statusCode)
        return { error: err.message }
      }
      req.log.error({ err }, "register failed")
      reply.code(500)
      return { error: "registration failed" }
    }
  })

  // POST /api/auth/login — local-account login.
  app.post<{ Body: LoginBody }>("/api/auth/login", async (req, reply) => {
    const { username = "", password = "" } = req.body ?? {}
    try {
      const user = verifyLocalLogin(username, password)
      loginAndSetCookie({
        reply,
        upn:       user.upn,
        ip:        req.ip,
        userAgent: String(req.headers["user-agent"] ?? ""),
      })
      return {
        upn:         user.upn,
        displayName: user.display_name,
        isAdmin:     user.is_admin === 1,
      }
    } catch (err) {
      if (err instanceof AuthError) {
        reply.code(err.statusCode)
        return { error: err.message }
      }
      req.log.error({ err }, "login failed")
      reply.code(500)
      return { error: "login failed" }
    }
  })

  // GET /api/auth/config — what the SPA needs to render the login screen
  // (whether to show the "Register" tab, mainly).
  app.get("/api/auth/config", async () => {
    return {
      registrationEnabled: localRegistrationEnabled(),
    }
  })
}
