/**
 * Browser credentials repo — vault-encrypted CRUD.
 *
 * Tenant boundary is the `owner_upn`. Every read enforces it, so a
 * cross-user lookup returns null even with a known credential id.
 *
 * Three credential kinds:
 *   password    — { username, password }
 *   totp        — { secret, digits?, period?, algorithm? }  (otplib config)
 *   cookie_jar  — Playwright storageState JSON (advanced; manual import)
 *
 * @module
 */

import { randomUUID } from "node:crypto"
import { CredentialKind } from "../../shared/enums/credentials.js"

import { getDb } from "../../platform/persistence/sqlite.js"
import { open, openJson, seal, sealJson } from "../../shared/utils/vault.js"

export { CredentialKind }

export interface PasswordPayload {
  username: string
  password: string
}
export interface TotpPayload {
  secret: string
  digits?: number
  period?: number
  algorithm?: "sha1" | "sha256" | "sha512"
}

export interface CredentialMetadata {
  id: string
  ownerUpn: string
  label: string
  kind: CredentialKind
  targetOrigin: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

interface Row {
  id: string
  owner_upn: string
  label: string
  kind: CredentialKind
  target_origin: string
  enc_payload: Buffer
  iv: Buffer
  auth_tag: Buffer
  created_at: string
  updated_at: string
  last_used_at: string | null
}

function toMetadata(r: Row): CredentialMetadata {
  return {
    id: r.id,
    ownerUpn: r.owner_upn,
    label: r.label,
    kind: r.kind,
    targetOrigin: r.target_origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at
  }
}

function payloadToString(kind: CredentialKind, payload: unknown): string {
  if (kind === "password") {
    const p = payload as PasswordPayload
    if (!p?.username || !p?.password) throw new Error("password credential requires { username, password }")
    return JSON.stringify(p)
  }
  if (kind === "totp") {
    const t = payload as TotpPayload
    if (!t?.secret) throw new Error("totp credential requires { secret }")
    return JSON.stringify(t)
  }
  if (kind === "cookie_jar") {
    return JSON.stringify(payload)
  }
  throw new Error(`unknown credential kind: ${kind}`)
}

export interface CreateCredentialInput {
  ownerUpn: string
  label: string
  kind: CredentialKind
  targetOrigin: string
  payload: unknown
}

export function createCredential(input: CreateCredentialInput): CredentialMetadata {
  const db = getDb()
  const id = randomUUID()
  const sealed = seal(payloadToString(input.kind, input.payload))
  db.prepare(
    `INSERT INTO browser_credentials
       (id, owner_upn, label, kind, target_origin, enc_payload, iv, auth_tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.ownerUpn,
    input.label,
    input.kind,
    input.targetOrigin,
    sealed.encPayload,
    sealed.iv,
    sealed.authTag
  )
  return toMetadata(db.prepare("SELECT * FROM browser_credentials WHERE id = ?").get(id) as Row)
}

export function listCredentials(ownerUpn: string): CredentialMetadata[] {
  const rows = getDb()
    .prepare("SELECT * FROM browser_credentials WHERE owner_upn = ? ORDER BY label")
    .all(ownerUpn) as Row[]
  return rows.map(toMetadata)
}

export function getCredentialMetadata(ownerUpn: string, id: string): CredentialMetadata | null {
  const row = getDb()
    .prepare("SELECT * FROM browser_credentials WHERE owner_upn = ? AND id = ?")
    .get(ownerUpn, id) as Row | undefined
  return row ? toMetadata(row) : null
}

/**
 * Decrypt and return the credential payload. Refuses cross-tenant access.
 * Touches `last_used_at` so audits can show staleness.
 */
export function openCredential<T = unknown>(
  ownerUpn: string,
  id: string
): { metadata: CredentialMetadata; payload: T } | null {
  const db = getDb()
  const row = db
    .prepare("SELECT * FROM browser_credentials WHERE owner_upn = ? AND id = ?")
    .get(ownerUpn, id) as Row | undefined
  if (!row) return null

  const sealed = { encPayload: row.enc_payload, iv: row.iv, authTag: row.auth_tag }
  const payload = row.kind === "cookie_jar" ? (openJson(sealed) as T) : (openJson(sealed) as T)
  // openJson is fine for password+totp too (both are JSON shapes).
  void open // keep tree-shake happy — direct `open()` not used here.

  db.prepare("UPDATE browser_credentials SET last_used_at = datetime('now') WHERE id = ?").run(id)

  return { metadata: toMetadata(row), payload }
}

export function deleteCredential(ownerUpn: string, id: string): boolean {
  const res = getDb()
    .prepare("DELETE FROM browser_credentials WHERE owner_upn = ? AND id = ?")
    .run(ownerUpn, id)
  return res.changes > 0
}

export function updateCredentialPayload(
  ownerUpn: string,
  id: string,
  payload: unknown
): CredentialMetadata | null {
  const db = getDb()
  const row = db
    .prepare("SELECT kind FROM browser_credentials WHERE owner_upn = ? AND id = ?")
    .get(ownerUpn, id) as { kind: CredentialKind } | undefined
  if (!row) return null
  const sealed = sealJson(JSON.parse(payloadToString(row.kind, payload)))
  db.prepare(
    `UPDATE browser_credentials
        SET enc_payload = ?, iv = ?, auth_tag = ?, updated_at = datetime('now')
      WHERE owner_upn = ? AND id = ?`
  ).run(sealed.encPayload, sealed.iv, sealed.authTag, ownerUpn, id)
  return getCredentialMetadata(ownerUpn, id)
}
