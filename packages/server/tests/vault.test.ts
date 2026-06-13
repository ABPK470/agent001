/**
 * Vault: round-trip seal/open, tamper rejection, key resolution from env
 * vs auto-generated file.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]
const ORIGINAL_VAULT_KEY = process.env["MIA_VAULT_KEY"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-vault-"))
  process.env["MIA_DATA_DIR"] = dataDir
  delete process.env["MIA_VAULT_KEY"]
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env["MIA_VAULT_KEY"]
  else process.env["MIA_VAULT_KEY"] = ORIGINAL_VAULT_KEY
})

describe("vault", () => {
  it("auto-generates a key file on first use and round-trips text", async () => {
    const { _resetVaultKeyCache, seal, open } = await import("../src/shared/utils/vault.js")
    _resetVaultKeyCache()

    const sealed = seal("hello world")
    expect(sealed.encPayload.length).toBeGreaterThan(0)
    expect(sealed.iv.length).toBe(12)
    expect(sealed.authTag.length).toBe(16)

    expect(open(sealed)).toBe("hello world")

    // Key file was written with mode 0600 (skip on Windows).
    const keyBuf = readFileSync(join(dataDir, "vault.key"))
    expect(keyBuf.length).toBe(32)
  })

  it("rejects tampered ciphertext", async () => {
    const { _resetVaultKeyCache, seal, open } = await import("../src/shared/utils/vault.js")
    _resetVaultKeyCache()
    const sealed = seal("secret")
    sealed.encPayload[0] = sealed.encPayload[0]! ^ 0x01
    expect(() => open(sealed)).toThrow()
  })

  it("rejects tampered auth tag", async () => {
    const { _resetVaultKeyCache, seal, open } = await import("../src/shared/utils/vault.js")
    _resetVaultKeyCache()
    const sealed = seal("secret")
    sealed.authTag[0] = sealed.authTag[0]! ^ 0x01
    expect(() => open(sealed)).toThrow()
  })

  it("uses MIA_VAULT_KEY env when set (hex 64 chars)", async () => {
    process.env["MIA_VAULT_KEY"] = "00".repeat(32)
    const { _resetVaultKeyCache, getVaultKey } = await import("../src/shared/utils/vault.js")
    _resetVaultKeyCache()
    const k = getVaultKey()
    expect(k.length).toBe(32)
    expect(k.equals(Buffer.alloc(32))).toBe(true)
  })

  it("rejects MIA_VAULT_KEY of wrong length", async () => {
    process.env["MIA_VAULT_KEY"] = "abcd"
    const { _resetVaultKeyCache, getVaultKey } = await import("../src/shared/utils/vault.js")
    _resetVaultKeyCache()
    expect(() => getVaultKey()).toThrow(/MIA_VAULT_KEY/)
  })

  it("seals/opens JSON values", async () => {
    const { _resetVaultKeyCache, sealJson, openJson } = await import("../src/shared/utils/vault.js")
    _resetVaultKeyCache()
    const sealed = sealJson({ user: "alice", pw: "p@ss" })
    expect(openJson(sealed)).toEqual({ user: "alice", pw: "p@ss" })
  })
})
