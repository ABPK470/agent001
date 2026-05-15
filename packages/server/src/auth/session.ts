/**
 * Session cookie helpers — HMAC-signed opaque session IDs.
 *
 * The cookie value is a sid + signature only. All identity (upn,
 * displayName, isAdmin) is looked up from the DB via JOIN with the
 * users table — the cookie carries no identity claims. This means:
 *
 *   - Revoking a session = DELETE FROM sessions WHERE sid = ?  (the
 *     cookie still parses but no row matches, so onRequest 401's).
 *   - Changing a user's display name or admin flag is reflected on
 *     their next request — no stale cookie payloads.
 *   - The cookie is useless without the server-side sessions row.
 *
 * Compare with the v18 design (deleted): cookie used to carry
 * { sid, displayName, upn, isAdmin, createdAt } so admin promotion
 * via env-var changes never took effect for existing sessions, and
 * the entire identity model could be tampered with by replaying old
 * cookies. The new opaque-sid model eliminates both classes of bug.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE = "mia_sid"
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30   // 30 days

function getSecret(): Buffer {
  const raw = process.env["MIA_COOKIE_SECRET"]
  if (!raw || raw.length < 16) {
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

/** Produce a signed cookie value carrying just `sid`. */
export function signSid(sid: string): string {
  const body = b64url(Buffer.from(sid, "utf8"))
  const sig = createHmac("sha256", getSecret()).update(body).digest()
  return `${body}.${b64url(sig)}`
}

/** Verify a signed cookie value and return the sid, or null if invalid. */
export function verifySid(raw: string | undefined): string | null {
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
    const sid = b64urlDecode(body).toString("utf8")
    if (!sid) return null
    return sid
  } catch { return null }
}

export function newSid(): string {
  return randomBytes(16).toString("hex")
}
