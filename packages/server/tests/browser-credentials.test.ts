/**
 * Browser credentials store: tenant isolation, vault round-trip,
 * cross-user denial, kind validation, TOTP code generation via the
 * server-side credential provider.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedTestUsers } from "./_fk-helpers.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]
const ORIGINAL_VAULT_KEY = process.env["MIA_VAULT_KEY"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-cred-"))
  process.env["MIA_DATA_DIR"] = dataDir
  process.env["MIA_VAULT_KEY"] = "11".repeat(32)
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env["MIA_VAULT_KEY"]
  else process.env["MIA_VAULT_KEY"] = ORIGINAL_VAULT_KEY
})

async function bootstrap(): Promise<void> {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _migrate(testDb)
  _setDb(testDb)
  seedTestUsers(testDb)
  const { _resetVaultKeyCache } = await import("../src/crypto/vault.js")
  _resetVaultKeyCache()
}

describe("browser credentials store", () => {
  it("creates, lists, and round-trips a password credential", async () => {
    await bootstrap()
    const { createCredential, listCredentials, openCredential } =
      await import("../src/features/browser/application/credentials.js")

    const meta = createCredential({
      ownerUpn: "alice@example.com",
      label: "github",
      kind: "password",
      targetOrigin: "https://github.com",
      payload: { username: "alice", password: "s3cret!" }
    })
    expect(meta.id).toMatch(/[0-9a-f-]+/)
    expect(meta.label).toBe("github")

    const list = listCredentials("alice@example.com")
    expect(list.length).toBe(1)

    const opened = openCredential<{ username: string; password: string }>("alice@example.com", meta.id)
    expect(opened?.payload).toEqual({ username: "alice", password: "s3cret!" })
  })

  it("refuses cross-tenant access", async () => {
    await bootstrap()
    const { createCredential, openCredential, listCredentials } =
      await import("../src/features/browser/application/credentials.js")

    const m = createCredential({
      ownerUpn: "alice@example.com",
      label: "shared",
      kind: "password",
      targetOrigin: "https://example.com",
      payload: { username: "a", password: "b" }
    })

    expect(openCredential("bob@example.com", m.id)).toBeNull()
    expect(listCredentials("bob@example.com").length).toBe(0)
  })

  it("validates payload shape per kind", async () => {
    await bootstrap()
    const { createCredential } = await import("../src/features/browser/application/credentials.js")

    expect(() =>
      createCredential({
        ownerUpn: "alice@example.com",
        label: "bad",
        kind: "password",
        targetOrigin: "x",
        payload: { username: "only" }
      })
    ).toThrow(/password credential requires/)

    expect(() =>
      createCredential({
        ownerUpn: "alice@example.com",
        label: "bad-totp",
        kind: "totp",
        targetOrigin: "x",
        payload: {}
      })
    ).toThrow(/totp credential requires/)
  })

  it("server provider generates TOTP codes and refuses cross-tenant", async () => {
    await bootstrap()
    const { createCredential } = await import("../src/features/browser/application/credentials.js")
    const { createServerBrowserCredentialProvider } =
      await import("../src/features/browser/runtime/credential-provider.js")

    // RFC 6238 Appendix B test vector secret (base32 of "12345678901234567890")
    const meta = createCredential({
      ownerUpn: "alice@example.com",
      label: "test-totp",
      kind: "totp",
      targetOrigin: "https://example.com",
      payload: { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", digits: 6, period: 30 }
    })

    const aliceProvider = createServerBrowserCredentialProvider("alice@example.com")
    const bobProvider = createServerBrowserCredentialProvider("bob@example.com")

    const aliceCode = await aliceProvider.resolveTotp(meta.id)
    expect(aliceCode?.code).toMatch(/^\d{6}$/)
    expect(aliceCode?.label).toBe("test-totp")

    const bobCode = await bobProvider.resolveTotp(meta.id)
    expect(bobCode).toBeNull()
  })

  it("server provider returns null for anonymous sessions", async () => {
    await bootstrap()
    const { serverBrowserCredentialProvider } =
      await import("../src/features/browser/runtime/credential-provider.js")
    expect(await serverBrowserCredentialProvider.resolvePassword("anything")).toBeNull()
    expect(await serverBrowserCredentialProvider.resolveTotp("anything")).toBeNull()
  })
})
