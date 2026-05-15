/**
 * Vault — symmetric encryption for at-rest secrets (browser credentials,
 * proxy URLs, anything that must never sit in the DB plaintext).
 *
 * Algorithm: AES-256-GCM via `node:crypto`. No third-party crypto.
 *
 * Master key resolution order:
 *   1. `MIA_VAULT_KEY` env var (hex, 64 chars = 32 bytes). Recommended
 *      for production.
 *   2. `~/.mia/vault.key` file. Auto-generated on first call when missing,
 *      written with mode 0o600. A warning is logged so operators know to
 *      back it up.
 *
 * Each encryption uses a fresh 12-byte IV. The output structure is split
 * across three columns (`enc_payload`, `iv`, `auth_tag`) rather than a
 * single concatenated blob to keep schema legible and SQL queries
 * straightforward.
 *
 * @module
 */

import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
} from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const KEY_LENGTH = 32 // AES-256
const IV_LENGTH = 12 // GCM-recommended

let cachedKey: Buffer | null = null

function vaultKeyPath(): string {
  const dataDir = process.env["MIA_DATA_DIR"] || join(homedir(), ".mia")
  return join(dataDir, "vault.key")
}

/**
 * Resolve the master vault key. Caches the buffer for the process lifetime.
 * Throws if `MIA_VAULT_KEY` is set but invalid (we refuse to silently fall
 * through to file-based key when the operator clearly intended an env key).
 */
export function getVaultKey(): Buffer {
  if (cachedKey) return cachedKey

  const fromEnv = process.env["MIA_VAULT_KEY"]
  if (fromEnv && fromEnv.length > 0) {
    const buf = Buffer.from(fromEnv.trim(), "hex")
    if (buf.length !== KEY_LENGTH) {
      throw new Error(
        `MIA_VAULT_KEY is set but is ${buf.length} bytes after hex decode; expected ${KEY_LENGTH}.`,
      )
    }
    cachedKey = buf
    return cachedKey
  }

  const path = vaultKeyPath()
  if (existsSync(path)) {
    const buf = readFileSync(path)
    if (buf.length !== KEY_LENGTH) {
      throw new Error(
        `Vault key at ${path} is ${buf.length} bytes; expected ${KEY_LENGTH}. Restore from backup or delete to regenerate (will lose access to existing encrypted data).`,
      )
    }
    cachedKey = buf
    return cachedKey
  }

  // First-run auto-generation. Print a one-line warning so operators
  // realise this key MUST be backed up — losing it loses every credential.
  const fresh = randomBytes(KEY_LENGTH)
  writeFileSync(path, fresh, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* best-effort on Windows */ }
  // eslint-disable-next-line no-console
  console.warn(`[vault] generated new master key at ${path} (mode 0600). Back it up — losing this key will permanently lose all encrypted credentials.`)
  cachedKey = fresh
  return cachedKey
}

/** @internal — testing helper. Reset the cached key so a new env var is picked up. */
export function _resetVaultKeyCache(): void {
  cachedKey = null
}

export interface SealedSecret {
  encPayload: Buffer
  iv: Buffer
  authTag: Buffer
}

/**
 * Seal an arbitrary value (object → JSON-encoded UTF-8 bytes).
 */
export function seal(plaintext: string): SealedSecret {
  const key = getVaultKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encPayload = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { encPayload, iv, authTag }
}

/**
 * Open a sealed secret. Throws if the auth tag doesn't verify (any
 * tampering — including bit-flip in IV or ciphertext — is rejected).
 */
export function open(sealed: SealedSecret): string {
  const key = getVaultKey()
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv)
  decipher.setAuthTag(sealed.authTag)
  const plaintext = Buffer.concat([
    decipher.update(sealed.encPayload),
    decipher.final(),
  ])
  return plaintext.toString("utf8")
}

/** Convenience: seal a JSON-serialisable object. */
export function sealJson(value: unknown): SealedSecret {
  return seal(JSON.stringify(value))
}

/** Convenience: open and JSON-parse. */
export function openJson<T = unknown>(sealed: SealedSecret): T {
  return JSON.parse(open(sealed)) as T
}
