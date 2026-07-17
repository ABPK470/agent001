/**
 * Auth transport door for the server package.
 */

import type { FastifyInstance } from "fastify"
import { AuthError, registerLocalUser, verifyLocalLogin } from "./service/users.js"
import { loginAndSetCookie } from "./state/identity.js"

function localRegistrationEnabled(): boolean {
  const raw = process.env["MIA_ALLOW_LOCAL_REGISTRATION"]
  if (raw === "1" || raw === "true") return true
  if (raw === "0" || raw === "false") return false
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
        upn: user.upn,
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] ?? "")
      })
      reply.code(201)
      return {
        upn: user.upn,
        displayName: user.display_name,
        isAdmin: user.is_admin === 1
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

  app.post<{ Body: LoginBody }>("/api/auth/login", async (req, reply) => {
    const { username = "", password = "" } = req.body ?? {}
    try {
      const user = verifyLocalLogin(username, password)
      loginAndSetCookie({
        reply,
        upn: user.upn,
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] ?? "")
      })
      return {
        upn: user.upn,
        displayName: user.display_name,
        isAdmin: user.is_admin === 1
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

  app.get("/api/auth/config", async () => {
    return {
      registrationEnabled: localRegistrationEnabled()
    }
  })
}
