/**
 * Users persistence — the canonical identity table.
 *
 * Typed via the platform schema toolkit (Kysely compile → SQLite execute).
 * Identity mutations that need bcrypt live in auth layers; this is the DB surface.
 */

import { sql } from "kysely"
import { UserSource } from "../../../../../internal/enums/auth.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

export interface DbUser {
  upn: string // canonical, lowercased
  username: string | null // for local accounts; SSO accounts often null (or = upn)
  display_name: string
  is_admin: number // 0 | 1
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
  const compiled = getPlatformDb()
    .insertInto("users")
    .values({
      upn: u.upn.toLowerCase(),
      username: u.username?.toLowerCase() ?? null,
      display_name: u.displayName,
      is_admin: u.isAdmin ? 1 : 0,
      password_hash: u.passwordHash,
      source: u.source,
      created_at: sql`datetime('now')`,
      last_login_at: null,
    })
    .compile()
  runExec(compiled)
}

export function findUserByUpn(upn: string): DbUser | undefined {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .selectAll()
    .where("upn", "=", upn.toLowerCase())
    .compile()
  return runGet<DbUser>(compiled)
}

export function findUserByUsername(username: string): DbUser | undefined {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username.toLowerCase())
    .compile()
  return runGet<DbUser>(compiled)
}

export function updateLastLoginAt(upn: string): void {
  const compiled = getPlatformDb()
    .updateTable("users")
    .set({ last_login_at: sql`datetime('now')` })
    .where("upn", "=", upn.toLowerCase())
    .compile()
  runExec(compiled)
}

export function countUsers(): number {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .select(sql<number>`count(*)`.as("n"))
    .compile()
  const row = runGet<{ n: number | bigint }>(compiled)
  return Number(row?.n ?? 0)
}

export function listUsers(): DbUser[] {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .selectAll()
    .orderBy("created_at", "desc")
    .compile()
  return runAll<DbUser>(compiled)
}

export function countAdmins(): number {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .select(sql<number>`count(*)`.as("n"))
    .where("is_admin", "=", 1)
    .compile()
  const row = runGet<{ n: number | bigint }>(compiled)
  return Number(row?.n ?? 0)
}

export function setUserAdmin(upn: string, isAdmin: boolean): DbUser {
  const normalized = upn.toLowerCase()
  const existing = findUserByUpn(normalized)
  if (!existing) {
    throw new Error(`user not found: ${upn}`)
  }
  if (!isAdmin && existing.is_admin === 1 && countAdmins() <= 1) {
    throw new Error("cannot demote the last admin")
  }
  const compiled = getPlatformDb()
    .updateTable("users")
    .set({ is_admin: isAdmin ? 1 : 0 })
    .where("upn", "=", normalized)
    .compile()
  runExec(compiled)
  const updated = findUserByUpn(normalized)
  if (!updated) throw new Error("user update failed")
  return updated
}
