/**
 * Tests for the attachments REST API.
 *
 * Spins up a bare Fastify instance with a tiny request hook that injects
 * a fake session, registers the attachment routes, and uses app.inject
 * to drive the endpoints. Storage and DB are redirected to per-test
 * temp locations.
 */

import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CurrentSession } from "../src/features/auth/runtime/context.js"
import { seedTestUsers } from "./_fk-helpers.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

interface BuildOptions {
  session: CurrentSession | null
}

async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  // Dynamic import after env is set so storage uses our temp dir.
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  const { registerAttachmentRoutes } = await import("../src/features/attachments/routes.js")
  _setDb(testDb)
  _migrate(testDb)
  seedTestUsers(testDb)

  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    if (opts.session) {
      ;(req as unknown as { session: CurrentSession }).session = opts.session
      // FK on attachments.session_id + owner_upn require parent rows.
      const { seedUser, seedSession } = await import("./_fk-helpers.js")
      seedUser(testDb, opts.session.upn, {
        displayName: opts.session.displayName,
        isAdmin: opts.session.isAdmin
      })
      seedSession(testDb, opts.session.sid, opts.session.upn)
    }
  })
  registerAttachmentRoutes(app)
  await app.ready()
  return app
}

function fakeSession(over: Partial<CurrentSession> = {}): CurrentSession {
  return {
    sid: over.sid ?? "sid-test",
    displayName: over.displayName ?? "Test User",
    upn: over.upn ?? "test.user@example.com",
    isAdmin: over.isAdmin ?? false,
    ip: over.ip ?? "127.0.0.1",
    userAgent: over.userAgent ?? "vitest"
  }
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64")
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-attach-routes-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("attachments REST API", () => {
  it("rejects unauthenticated upload with 401", async () => {
    const app = await buildApp({ session: null })
    const res = await app.inject({
      method: "POST",
      url: "/api/attachments",
      payload: { name: "x.txt", contentBase64: b64("hi") }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it("uploads, lists, downloads, and deletes", async () => {
    const app = await buildApp({ session: fakeSession() })

    // Upload
    const upload = await app.inject({
      method: "POST",
      url: "/api/attachments",
      payload: { name: "notes.txt", mediaType: "text/plain", contentBase64: b64("hello world") }
    })
    expect(upload.statusCode).toBe(201)
    const created = upload.json() as { id: string; sizeBytes: number; ingestionMode: string }
    expect(created.sizeBytes).toBe("hello world".length)
    expect(created.ingestionMode).toBe("text_retrieval")

    // List (owner sees own)
    const list = await app.inject({ method: "GET", url: "/api/attachments" })
    expect(list.statusCode).toBe(200)
    const rows = list.json() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toContain(created.id)

    // Get one
    const one = await app.inject({ method: "GET", url: `/api/attachments/${created.id}` })
    expect(one.statusCode).toBe(200)

    // Download bytes
    const dl = await app.inject({ method: "GET", url: `/api/attachments/${created.id}/content` })
    expect(dl.statusCode).toBe(200)
    expect(dl.body).toBe("hello world")
    expect(dl.headers["content-type"]).toBe("text/plain")
    expect(dl.headers["content-disposition"]).toContain("notes.txt")

    // Delete
    const del = await app.inject({ method: "DELETE", url: `/api/attachments/${created.id}` })
    expect(del.statusCode).toBe(200)
    const after = await app.inject({ method: "GET", url: `/api/attachments/${created.id}` })
    expect(after.statusCode).toBe(404)

    await app.close()
  })

  it("non-owner cannot view another user's attachment, admin can", async () => {
    // Owner uploads
    const ownerApp = await buildApp({
      session: fakeSession({ sid: "sid-owner", upn: "owner@example.com" })
    })
    const upload = await ownerApp.inject({
      method: "POST",
      url: "/api/attachments",
      payload: { name: "secret.txt", contentBase64: b64("private") }
    })
    expect(upload.statusCode).toBe(201)
    const created = upload.json() as { id: string }
    await ownerApp.close()

    // Stranger forbidden
    const strangerApp = await buildApp({
      session: fakeSession({ sid: "sid-other", upn: "other@example.com" })
    })
    const forbidden = await strangerApp.inject({ method: "GET", url: `/api/attachments/${created.id}` })
    expect(forbidden.statusCode).toBe(403)

    // Stranger list excludes it (filtered by ownerUpn)
    const strangerList = await strangerApp.inject({ method: "GET", url: "/api/attachments" })
    expect((strangerList.json() as Array<{ id: string }>).map((r) => r.id)).not.toContain(created.id)
    await strangerApp.close()

    // Admin sees it
    const adminApp = await buildApp({
      session: fakeSession({ sid: "sid-admin", upn: "admin@example.com", isAdmin: true })
    })
    const adminGet = await adminApp.inject({ method: "GET", url: `/api/attachments/${created.id}` })
    expect(adminGet.statusCode).toBe(200)
    await adminApp.close()
  })

  it("validates body shape and limits", async () => {
    const app = await buildApp({ session: fakeSession() })

    const noName = await app.inject({
      method: "POST",
      url: "/api/attachments",
      payload: { contentBase64: b64("x") }
    })
    expect(noName.statusCode).toBe(400)

    const empty = await app.inject({
      method: "POST",
      url: "/api/attachments",
      payload: { name: "x.txt", contentBase64: "" }
    })
    expect(empty.statusCode).toBe(400)

    const runScopeMissingId = await app.inject({
      method: "POST",
      url: "/api/attachments",
      payload: { name: "x.txt", contentBase64: b64("x"), scope: "run" }
    })
    expect(runScopeMissingId.statusCode).toBe(400)

    await app.close()
  })
})
