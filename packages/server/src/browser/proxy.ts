/**
 * Browser proxy config repo — vault-encrypted BYO proxy URL per tenant.
 *
 * One row per `owner_upn` (PRIMARY KEY). Stores the upstream proxy URL
 * encrypted at rest using the same vault as credentials. Anonymous
 * sessions never get a row; they always use direct connection.
 *
 * Supported URL schemes (Playwright): `http://`, `https://`, `socks5://`.
 * Optional username/password may be embedded in the URL or kept separate.
 *
 * @module
 */

import { getDb } from "../adapters/persistence/sqlite.js"
import { open, seal } from "../crypto/vault.js"

export interface ProxyConfig {
  ownerUpn: string
  /** Resolved upstream proxy URL (decrypted). */
  server: string
  /** Comma-separated host patterns to bypass (Playwright format). */
  bypass: string
  updatedAt: string
}

interface Row {
  owner_upn: string
  enc_url: Buffer
  iv: Buffer
  auth_tag: Buffer
  bypass: string
  updated_at: string
}

const VALID_SCHEME = /^(https?|socks5):\/\//i

function validateUrl(url: string): void {
  if (!VALID_SCHEME.test(url)) {
    throw new Error("proxy URL must start with http://, https://, or socks5://")
  }
  // Reject patently malformed URLs.
  try {
    // eslint-disable-next-line no-new
    new URL(url)
  } catch {
    throw new Error("proxy URL is not a valid URL")
  }
}

export function setProxyConfig(input: {
  ownerUpn: string
  server: string
  bypass?: string
}): ProxyConfig {
  validateUrl(input.server)
  const db = getDb()
  const sealed = seal(input.server)
  db.prepare(
    `INSERT INTO browser_proxy_config (owner_upn, enc_url, iv, auth_tag, bypass, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(owner_upn) DO UPDATE SET
       enc_url    = excluded.enc_url,
       iv         = excluded.iv,
       auth_tag   = excluded.auth_tag,
       bypass     = excluded.bypass,
       updated_at = datetime('now')`,
  ).run(
    input.ownerUpn,
    sealed.encPayload,
    sealed.iv,
    sealed.authTag,
    input.bypass ?? "",
  )
  return getProxyConfig(input.ownerUpn)!
}

export function getProxyConfig(ownerUpn: string): ProxyConfig | null {
  const row = getDb()
    .prepare("SELECT * FROM browser_proxy_config WHERE owner_upn = ?")
    .get(ownerUpn) as Row | undefined
  if (!row) return null
  const server = open({ encPayload: row.enc_url, iv: row.iv, authTag: row.auth_tag })
  return {
    ownerUpn: row.owner_upn,
    server,
    bypass: row.bypass,
    updatedAt: row.updated_at,
  }
}

export function deleteProxyConfig(ownerUpn: string): boolean {
  const res = getDb()
    .prepare("DELETE FROM browser_proxy_config WHERE owner_upn = ?")
    .run(ownerUpn)
  return res.changes > 0
}
