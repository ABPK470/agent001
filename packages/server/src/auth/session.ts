/**
 * Session cookie helpers — HMAC-signed cookies carrying self-declared
 * user identity (display name + UPN).
 *
 * The cookie payload is NOT authentication. It's an audit-trail tag the
 * user enters once via the welcome modal. Auto-admin (UPN whitelist) +
 * optional admin password are the trust mechanisms.
 *
 * Format: <base64url(json)>.<base64url(hmac-sha256)>
 *   where json = { sid, displayName, upn, createdAt }
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE = "mia_sid"
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30   // 30 days

export interface SessionPayload {
  sid: string                 // random per-user id (stable across requests)
  displayName: string         // e.g. Joe Smith — whatever the user entered in the welcome modal
  upn: string | null          // e.g. "joe.smith@domain.com" — may be null for anonymous
  isAdmin?: boolean           // stamped at login; survives server restarts / .env changes
  createdAt: number           // epoch ms
}

function getSecret(): Buffer {
  const raw = process.env["MIA_COOKIE_SECRET"]
  if (!raw || raw.length < 16) {
    // Dev fallback: a fixed-but-warned secret. In production this MUST be set.
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("MIA_COOKIE_SECRET must be set in production (>= 16 chars)")
    }
    return Buffer.from("dev-only-cookie-secret-do-not-use-in-prod-please-set-MIA_COOKIE_SECRET")
  }
  return Buffer.from(raw)
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  const padded = s + "=".repeat(pad)
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

export function signSession(payload: SessionPayload): string {
  const json = Buffer.from(JSON.stringify(payload), "utf8")
  const body = b64url(json)
  const sig = createHmac("sha256", getSecret()).update(body).digest()
  return `${body}.${b64url(sig)}`
}

export function verifySession(raw: string | undefined): SessionPayload | null {
  if (!raw) return null
  const parts = raw.split(".")
  if (parts.length !== 2) return null
  const [body, sigB64] = parts
  const expected = createHmac("sha256", getSecret()).update(body).digest()
  let actual: Buffer
  try { actual = b64urlDecode(sigB64) } catch { return null }
  if (actual.length !== expected.length) return null
  if (!timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8")) as SessionPayload
    if (typeof payload.sid !== "string" || payload.sid.length === 0) return null
    if (typeof payload.displayName !== "string") return null
    if (payload.upn !== null && typeof payload.upn !== "string") return null
    if (typeof payload.createdAt !== "number") return null
    return payload
  } catch { return null }
}

export function newSid(): string {
  return randomBytes(16).toString("hex")
}

export const ADMIN_COOKIE = "mia_admin"

export function signAdminCookie(): string {
  // Just a signed marker — the value is the timestamp so we can later add expiry.
  const body = b64url(Buffer.from(String(Date.now())))
  const sig = createHmac("sha256", getSecret()).update(body).digest()
  return `${body}.${b64url(sig)}`
}

export function verifyAdminCookie(raw: string | undefined): boolean {
  if (!raw) return false
  const parts = raw.split(".")
  if (parts.length !== 2) return false
  const [body, sigB64] = parts
  const expected = createHmac("sha256", getSecret()).update(body).digest()
  let actual: Buffer
  try { actual = b64urlDecode(sigB64) } catch { return false }
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
