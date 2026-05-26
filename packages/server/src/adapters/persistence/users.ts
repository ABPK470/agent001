/**
 * Users persistence — the canonical identity table.
 *
 * Every per-user row in the system FK's into here via `upn`. There are
 * exactly two ways a row gets created:
 *   1. Local registration (POST /api/auth/register) → source='local',
 *      password_hash set.
 *   2. SSO header detection (auth/identity.ts) → source='sso',
 *      password_hash NULL.
 *
 * Identity mutations live in auth/users.ts (the layer that knows about
 * bcrypt). This module is the pure DB surface.
 */

import { UserSource } from "../../enums/auth.js"
import { getDb } from "./db-connection.js"

export interface DbUser {
  upn: string                  // canonical, lowercased
  username: string | null      // for local accounts; SSO accounts often null (or = upn)
  display_name: string
  is_admin: number             // 0 | 1
  password_hash: string | null // null for SSO accounts
  source: UserSource
  created_at: string
  last_login_at: string | null
}

export interface InsertUserInput {
  upn: string
  username: string | null
  displayName: string
  isAdmin: boolean
  passwordHash: string | null
  source: UserSource
}

export function insertUser(u: InsertUserInput): void {
  getDb().prepare(`
    INSERT INTO users (upn, username, display_name, is_admin, password_hash, source, created_at)
    VALUES (@upn, @username, @display_name, @is_admin, @password_hash, @source, datetime('now'))
  `).run({
    upn:           u.upn.toLowerCase(),
    username:      u.username?.toLowerCase() ?? null,
    display_name:  u.displayName,
    is_admin:      u.isAdmin ? 1 : 0,
    password_hash: u.passwordHash,
    source:        u.source,
  })
}

export function findUserByUpn(upn: string): DbUser | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE upn = ?")
    .get(upn.toLowerCase()) as DbUser | undefined
}

export function findUserByUsername(username: string): DbUser | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username.toLowerCase()) as DbUser | undefined
}

export function updateLastLoginAt(upn: string): void {
  getDb()
    .prepare("UPDATE users SET last_login_at = datetime('now') WHERE upn = ?")
    .run(upn.toLowerCase())
}

export function countUsers(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
  return row.n
}

export function listUsers(): DbUser[] {
  return getDb()
    .prepare("SELECT * FROM users ORDER BY created_at DESC")
    .all() as DbUser[]
}
