/**
 * Users persistence — the canonical identity table.
 *
 * Typed via the platform schema toolkit (Kysely compile → SQLite execute).
 * Identity mutations that need bcrypt live in auth layers; this is the DB surface.
 */

import { sql } from "kysely"
import { UserSource } from "../../../../../internal/enums/auth.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"

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

export async function insertUser(u: InsertUserInput): Promise<void> {
  const compiled = getPlatformDb()
    .insertInto("users")
    .values({
      upn: u.upn.toLowerCase(),
      username: u.username?.toLowerCase() ?? null,
      display_name: u.displayName,
      is_admin: u.isAdmin ? 1 : 0,
      password_hash: u.passwordHash,
      source: u.source,
      created_at: platformNow(),
      last_login_at: null,
    })
    .compile()
  await runExecAsync(compiled)
}

export async function findUserByUpn(upn: string): Promise<DbUser | undefined> {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .selectAll()
    .where("upn", "=", upn.toLowerCase())
    .compile()
  return await runGetAsync<DbUser>(compiled)
}

export async function findUserByUsername(username: string): Promise<DbUser | undefined> {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username.toLowerCase())
    .compile()
  return await runGetAsync<DbUser>(compiled)
}

export async function updateLastLoginAt(upn: string): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("users")
    .set({ last_login_at: platformNow() })
    .where("upn", "=", upn.toLowerCase())
    .compile()
  await runExecAsync(compiled)
}

export async function countUsers(): Promise<number> {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .select(sql<number>`count(*)`.as("n"))
    .compile()
  const row = await runGetAsync<{ n: number | bigint }>(compiled)
  return Number(row?.n ?? 0)
}

export async function listUsers(): Promise<DbUser[]> {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .selectAll()
    .orderBy("created_at", "desc")
    .compile()
  return await runAllAsync<DbUser>(compiled)
}

export async function countAdmins(): Promise<number> {
  const compiled = getPlatformDb()
    .selectFrom("users")
    .select(sql<number>`count(*)`.as("n"))
    .where("is_admin", "=", 1)
    .compile()
  const row = await runGetAsync<{ n: number | bigint }>(compiled)
  return Number(row?.n ?? 0)
}

export async function setUserAdmin(upn: string, isAdmin: boolean): Promise<DbUser> {
  const normalized = upn.toLowerCase()
  const existing = await findUserByUpn(normalized)
  if (!existing) {
    throw new Error(`user not found: ${upn}`)
  }
  if (!isAdmin && existing.is_admin === 1 && await countAdmins() <= 1) {
    throw new Error("cannot demote the last admin")
  }
  const compiled = getPlatformDb()
    .updateTable("users")
    .set({ is_admin: isAdmin ? 1 : 0 })
    .where("upn", "=", normalized)
    .compile()
  await runExecAsync(compiled)
  const updated = await findUserByUpn(normalized)
  if (!updated) throw new Error("user update failed")
  return updated
}
