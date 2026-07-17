/**
 * Authentication primitives — bcrypt-backed password hashing on top of
 * the users DB layer.
 *
 * Bug class this layer exists to prevent: storing passwords in cleartext,
 * comparing hashes with non-constant-time helpers, or letting two
 * different code paths derive identity differently. Every identity mint
 * goes through registerLocalUser() or upsertSsoUser() — there are no
 * other accounts.
 */

import bcrypt from "bcryptjs"
import {
  countUsers,
  findUserByUpn,
  findUserByUsername,
  insertUser,
  updateLastLoginAt,
  type DbUser
} from "../../../platform/persistence/users.js"
import { UserSource } from "../../../shared/enums/auth.js"

const BCRYPT_ROUNDS = 10 // dev-grade; raise if/when production volume warrants

export interface RegisterInput {
  username: string
  password: string
  displayName: string
  isAdmin?: boolean
}

export interface SsoUpsertInput {
  upn: string
  displayName: string
  isAdmin?: boolean
}

/**
 * Create a local-account user. Throws if the username (or its derived
 * upn) is already taken. The username doubles as the upn for local
 * accounts so per-user FKs use a single canonical key.
 */
export function registerLocalUser(input: RegisterInput): DbUser {
  const username = input.username.trim().toLowerCase()
  if (!username) throw new AuthError("username required", 400)
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(input.username.trim())) {
    throw new AuthError("username must be 2-64 chars, [A-Za-z0-9._-]", 400)
  }
  if (!input.password || input.password.length < 4) {
    throw new AuthError("password must be at least 4 characters", 400)
  }
  const displayName = input.displayName.trim()
  if (!displayName) throw new AuthError("displayName required", 400)

  // For local accounts, upn = username so the FK key is single-source.
  const upn = username

  if (findUserByUsername(username) || findUserByUpn(upn)) {
    throw new AuthError("username already taken", 409)
  }

  const passwordHash = bcrypt.hashSync(input.password, BCRYPT_ROUNDS)
  // First-user-wins admin policy: when the users table is empty, whoever
  // registers first becomes the sole admin. Combined with the auto-
  // register-on-first-login flow, this means the very first credentials
  // typed at the welcome screen own the platform — no env vars to set,
  // no separate admin step. Subsequent registrations get isAdmin=false
  // regardless of what the caller passes.
  const isFirstUser = countUsers() === 0
  insertUser({
    upn,
    username,
    displayName,
    isAdmin: isFirstUser || input.isAdmin === true,
    passwordHash,
    source: UserSource.Local
  })
  const created = findUserByUpn(upn)
  if (!created) throw new AuthError("user creation failed", 500)
  return created
}

/**
 * Look up a user by username and verify password. Returns the user on
 * success; throws AuthError(401) on failure (intentionally indistinct
 * "user not found" vs "wrong password" to avoid username enumeration).
 */
export function verifyLocalLogin(username: string, password: string): DbUser {
  const u = findUserByUsername(username.trim().toLowerCase())
  if (!u || u.source !== UserSource.Local || !u.password_hash) {
    throw new AuthError("invalid credentials", 401)
  }
  if (!bcrypt.compareSync(password, u.password_hash)) {
    throw new AuthError("invalid credentials", 401)
  }
  updateLastLoginAt(u.upn)
  return u
}

/**
 * Find-or-create an SSO-derived user. Called from the identity hook
 * when a trusted proxy header (From-User-Name / X-Forwarded-User /
 * X-Remote-User) carries a UPN we haven't seen before.
 */
export function upsertSsoUser(input: SsoUpsertInput): DbUser {
  const upn = input.upn.trim().toLowerCase()
  if (!upn) throw new AuthError("upn required", 400)

  const existing = findUserByUpn(upn)
  if (existing) {
    updateLastLoginAt(upn)
    return existing
  }
  insertUser({
    upn,
    username: null,
    displayName: input.displayName.trim() || upn,
    isAdmin: input.isAdmin === true,
    passwordHash: null,
    source: UserSource.Sso
  })
  const created = findUserByUpn(upn)
  if (!created) throw new AuthError("sso user creation failed", 500)
  return created
}

/**
 * One-shot bootstrap — create the first admin if the users table is
 * empty AND env vars are set. Called from server startup after the
 * DB schema is migrated.
 *
 * Logs (via console) a loud warning if the DB is empty but env vars are
 * unset — without an admin no one can register the first user (since
 * /api/auth/register may be gated by MIA_ALLOW_LOCAL_REGISTRATION in
 * prod).
 */
export function bootstrapAdminFromEnv(): void {
  if (countUsers() > 0) return
  const username = (process.env["MIA_BOOTSTRAP_ADMIN_USERNAME"] || "").trim()
  const password = process.env["MIA_BOOTSTRAP_ADMIN_PASSWORD"] || ""
  const displayName = (process.env["MIA_BOOTSTRAP_ADMIN_DISPLAY_NAME"] || "Admin").trim()
  if (!username || !password) {
    console.warn(
      "[auth] users table is empty and MIA_BOOTSTRAP_ADMIN_USERNAME / MIA_BOOTSTRAP_ADMIN_PASSWORD are not set. " +
        "No one can log in. Set these env vars and restart the server."
    )
    return
  }
  try {
    registerLocalUser({ username, password, displayName, isAdmin: true })
    console.warn(`[auth] bootstrap admin '${username}' created from env`)
  } catch (err) {
    console.error("[auth] failed to bootstrap admin from env:", err)
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message)
    this.name = "AuthError"
  }
}
