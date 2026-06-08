/**
 * Browser proxy config repo: vault-encrypted CRUD with tenant isolation
 * and URL validation.
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

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-proxy-"))
  process.env["MIA_DATA_DIR"] = dataDir
  process.env["MIA_VAULT_KEY"] = "22".repeat(32)
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
  const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
  _migrate(testDb)
  _setDb(testDb)
  seedTestUsers(testDb)
  const { _resetVaultKeyCache } = await import("../src/crypto/vault.js")
  _resetVaultKeyCache()
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env["MIA_VAULT_KEY"]
  else process.env["MIA_VAULT_KEY"] = ORIGINAL_VAULT_KEY
})

describe("browser proxy config", () => {
  it("sets, reads, updates, and deletes a proxy", async () => {
    const { setProxyConfig, getProxyConfig, deleteProxyConfig } = await import("../src/browser/proxy.js")

    expect(getProxyConfig("alice@example.com")).toBeNull()

    const created = setProxyConfig({
      ownerUpn: "alice@example.com",
      server: "http://corp-proxy:8080",
      bypass: "*.local,127.0.0.1"
    })
    expect(created.server).toBe("http://corp-proxy:8080")
    expect(created.bypass).toBe("*.local,127.0.0.1")

    const updated = setProxyConfig({
      ownerUpn: "alice@example.com",
      server: "socks5://localhost:1080"
    })
    expect(updated.server).toBe("socks5://localhost:1080")
    expect(updated.bypass).toBe("")

    const fetched = getProxyConfig("alice@example.com")
    expect(fetched?.server).toBe("socks5://localhost:1080")

    expect(deleteProxyConfig("alice@example.com")).toBe(true)
    expect(getProxyConfig("alice@example.com")).toBeNull()
  })

  it("rejects invalid URLs and unsupported schemes", async () => {
    const { setProxyConfig } = await import("../src/browser/proxy.js")
    expect(() => setProxyConfig({ ownerUpn: "u@x", server: "ftp://nope" })).toThrow(/http|socks5/)
    expect(() => setProxyConfig({ ownerUpn: "u@x", server: "not-a-url" })).toThrow(/http|socks5/)
  })

  it("isolates tenants", async () => {
    const { setProxyConfig, getProxyConfig } = await import("../src/browser/proxy.js")
    setProxyConfig({ ownerUpn: "alice@example.com", server: "http://a:1" })
    setProxyConfig({ ownerUpn: "bob@example.com", server: "http://b:2" })
    expect(getProxyConfig("alice@example.com")?.server).toBe("http://a:1")
    expect(getProxyConfig("bob@example.com")?.server).toBe("http://b:2")
    expect(getProxyConfig("eve@example.com")).toBeNull()
  })
})
