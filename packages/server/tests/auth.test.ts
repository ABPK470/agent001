/**
 * Auth routes — register / login / logout / whoami / SSO / revoke.
 *
 * The point of this suite is to anchor the v19 contract end-to-end:
 *   - POST /api/auth/register and /api/auth/login mint a signed sid cookie.
 *   - Subsequent requests JOIN sessions ⨯ users to resolve identity.
 *   - DELETE-ing the sessions row immediately invalidates the cookie
 *     (no in-memory cache; identity is always DB-derived).
 *   - SSO header on first contact provisions a `users` row (source='sso')
 *     and mints a session.
 *   - Protected routes return 401 without a session; auth-bypass paths
 *     do not.
 *   - Wrong password returns 401 with a generic message (no user-enum).
 */

import fastifyCookie from "@fastify/cookie"
import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]
const ORIGINAL_REG = process.env["MIA_ALLOW_LOCAL_REGISTRATION"]
const ORIGINAL_SECRET = process.env["MIA_SESSION_SECRET"]

async function buildApp(): Promise<FastifyInstance> {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  const { registerAuthRoutes, registerIdentity, registerLocalUser } =
    await import("../src/api/auth/index.js")
  _setDb(testDb)
  _migrate(testDb)
  // Seed a sentinel admin so the first-user-becomes-admin auto-promotion
  // doesn't fire for the test fixtures (alice/bob/etc.). The tests below
  // care about the *default* registration semantics — non-admin unless
  // explicitly promoted — so they need to register as the *second* user.
  registerLocalUser({ username: "_seed_admin", password: "seedseedpw", displayName: "Seed", isAdmin: true })

  const app = Fastify({ logger: false })
  await app.register(fastifyCookie)
  await registerAuthRoutes(app)
  await registerIdentity(app)

  // A trivial protected route so we can prove the 401 gate fires.
  app.get("/api/protected", async (req) => ({ upn: req.session?.upn ?? null }))

  await app.ready()
  return app
}

function cookieFromSetCookie(header: string | string[] | undefined): string {
  if (!header) return ""
  const arr = Array.isArray(header) ? header : [header]
  const first = arr.find((s) => s.startsWith("mia_sid="))
  if (!first) return ""
  return first.split(";")[0] // "mia_sid=..."
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-auth-"))
  process.env["MIA_DATA_DIR"] = dataDir
  process.env["MIA_ALLOW_LOCAL_REGISTRATION"] = "1"
  process.env["MIA_SESSION_SECRET"] = "test-secret-test-secret-test-secret-12"
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  if (ORIGINAL_REG === undefined) delete process.env["MIA_ALLOW_LOCAL_REGISTRATION"]
  else process.env["MIA_ALLOW_LOCAL_REGISTRATION"] = ORIGINAL_REG
  if (ORIGINAL_SECRET === undefined) delete process.env["MIA_SESSION_SECRET"]
  else process.env["MIA_SESSION_SECRET"] = ORIGINAL_SECRET
})

describe("auth routes — local registration", () => {
  it("registers a user, sets a signed cookie, and exposes them via /whoami", async () => {
    const app = await buildApp()
    try {
      const reg = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: "alice", password: "hunter2pw", displayName: "Alice" }
      })
      expect(reg.statusCode).toBe(201)
      const body = reg.json() as { upn: string; displayName: string; isAdmin: boolean }
      expect(body.upn).toBe("alice")
      expect(body.displayName).toBe("Alice")
      expect(body.isAdmin).toBe(false)

      const cookie = cookieFromSetCookie(reg.headers["set-cookie"])
      expect(cookie).toMatch(/^mia_sid=/)

      const who = await app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { cookie }
      })
      expect(who.statusCode).toBe(200)
      expect(who.json()).toMatchObject({ upn: "alice", displayName: "Alice", isAdmin: false })
    } finally {
      await app.close()
    }
  })

  it("accepts uppercase username input but canonicalizes the local-account key to lowercase", async () => {
    const app = await buildApp()
    try {
      const reg = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: "PKA", password: "hunter2pw", displayName: "PKA" }
      })
      expect(reg.statusCode).toBe(201)
      expect(reg.json()).toMatchObject({ upn: "pka", displayName: "PKA", isAdmin: false })

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "PKA", password: "hunter2pw" }
      })
      expect(login.statusCode).toBe(200)

      const cookie = cookieFromSetCookie(login.headers["set-cookie"])
      const who = await app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { cookie }
      })
      expect(who.statusCode).toBe(200)
      expect(who.json()).toMatchObject({ upn: "pka", displayName: "PKA", isAdmin: false })
    } finally {
      await app.close()
    }
  })

  it("rejects duplicate username with 409", async () => {
    const app = await buildApp()
    try {
      const payload = { username: "bob", password: "hunter2pw", displayName: "Bob" }
      const first = await app.inject({ method: "POST", url: "/api/auth/register", payload })
      expect(first.statusCode).toBe(201)
      const second = await app.inject({ method: "POST", url: "/api/auth/register", payload })
      expect(second.statusCode).toBe(409)
    } finally {
      await app.close()
    }
  })

  it("rejects short passwords with 400", async () => {
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: "carol", password: "ab", displayName: "Carol" }
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it("returns 403 when MIA_ALLOW_LOCAL_REGISTRATION=0", async () => {
    process.env["MIA_ALLOW_LOCAL_REGISTRATION"] = "0"
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: "dan", password: "hunter2pw", displayName: "Dan" }
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })
})

describe("auth routes — local login", () => {
  it("logs in with correct password and exposes session via /whoami", async () => {
    const app = await buildApp()
    try {
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: "eve", password: "hunter2pw", displayName: "Eve" }
      })
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "eve", password: "hunter2pw" }
      })
      expect(login.statusCode).toBe(200)
      const cookie = cookieFromSetCookie(login.headers["set-cookie"])
      const who = await app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { cookie }
      })
      expect(who.json()).toMatchObject({ upn: "eve", displayName: "Eve" })
    } finally {
      await app.close()
    }
  })

  it("returns 401 with generic message on wrong password (no user enumeration)", async () => {
    const app = await buildApp()
    try {
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: "frank", password: "hunter2pw", displayName: "Frank" }
      })
      const wrongPw = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "frank", password: "WRONGpw99" }
      })
      const noSuchUser = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "ghost", password: "anything9" }
      })
      expect(wrongPw.statusCode).toBe(401)
      expect(noSuchUser.statusCode).toBe(401)
      // Same generic message — no enum.
      expect((wrongPw.json() as { error: string }).error).toBe((noSuchUser.json() as { error: string }).error)
    } finally {
      await app.close()
    }
  })
})

describe("auth — gate", () => {
  it("returns 401 on protected routes without a session cookie", async () => {
    const app = await buildApp()
    try {
      const res = await app.inject({ method: "GET", url: "/api/protected" })
      expect(res.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })

  it("revoking the session row (deleteSession) immediately invalidates the cookie", async () => {
    const app = await buildApp()
    try {
      const reg = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: "harry", password: "hunter2pw", displayName: "Harry" }
      })
      const cookie = cookieFromSetCookie(reg.headers["set-cookie"])
      const before = await app.inject({
        method: "GET",
        url: "/api/protected",
        headers: { cookie }
      })
      expect(before.statusCode).toBe(200)
      expect(before.json()).toEqual({ upn: "harry" })

      // Server-side revoke — kill the row.
      const { deleteSessionsForUser } = await import("../src/infra/persistence/db/sessions.js")
      deleteSessionsForUser("harry")

      const after = await app.inject({
        method: "GET",
        url: "/api/protected",
        headers: { cookie }
      })
      expect(
        after.statusCode,
        "identity is JOIN-resolved every request — deleting the row instantly invalidates the cookie"
      ).toBe(401)
    } finally {
      await app.close()
    }
  })

  it("logout deletes the session row + clears the cookie", async () => {
    const app = await buildApp()
    try {
      const reg = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: "ivy", password: "hunter2pw", displayName: "Ivy" }
      })
      const cookie = cookieFromSetCookie(reg.headers["set-cookie"])
      const out = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie }
      })
      expect(out.statusCode).toBe(200)

      const after = await app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { cookie }
      })
      expect(after.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})

describe("auth — SSO header path", () => {
  it("first contact with From-User-Name auto-provisions a users row + mints a session", async () => {
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: {
          "from-user-name": "sso.user@corp",
          "from-first-name": "SSO",
          "from-last-name": "User"
        }
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ upn: "sso.user@corp", displayName: "SSO User" })

      const { findUserByUpn } = await import("../src/infra/persistence/db/users.js")
      const row = findUserByUpn("sso.user@corp")
      expect(row?.source).toBe("sso")
      expect(row?.password_hash).toBeNull()

      // The mint also set the cookie.
      expect(res.headers["set-cookie"]).toBeTruthy()
    } finally {
      await app.close()
    }
  })
})
