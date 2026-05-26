import { getDb } from "../adapters/persistence/sqlite.js"
import { rowToEntry } from "./schema.js"
import { WORKING_SESSION_WINDOW_H } from "./scoring.js"
import type { Memory, MemoryTier } from "./types.js"
import { entryToLegacy } from "./types.js"

// ── Maintenance ──────────────────────────────────────────────────

export function prune(): { deleted: number } {
  const db = getDb()

  // Remove entries below minimum confidence threshold
  const lowConf = db.prepare(
    "DELETE FROM memory_entries WHERE confidence < 0.05"
  ).run()

  // Delete accumulated failed working/assistant entries — these are failed-run answers
  // that were stored before the session-window guard was added.
  const failedWorking = db.prepare(
    "DELETE FROM memory_entries WHERE tier = 'working' AND role = 'assistant' AND confidence < 0.5"
  ).run()

  // Delete working-tier assistant entries that are older than the session window.
  // Answers within the window are valid hot context for follow-up questions; older ones
  // are no longer reachable by retrieval but this cleans them from storage so the DB
  // doesn't grow unboundedly.
  const windowCutoff = new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
  const staleAnswers = db.prepare(
    "DELETE FROM memory_entries WHERE tier = 'working' AND role = 'assistant' AND created_at < ?"
  ).run(windowCutoff)

  // Delete semantic entries with role='summary' — these were incorrectly promoted from
  // episodic by an old consolidate() version that did not exclude summary-role entries.
  // Goal-answer summaries belong in episodic only (one per goal, upserted).
  const staleSemantic = db.prepare(
    "DELETE FROM memory_entries WHERE tier = 'semantic' AND role = 'summary'"
  ).run()

  // Collapse duplicate episodic goal summaries — keeps the most recently updated
  // one per goal-prefix across ALL sessions.
  const duplicates = db.prepare(`
    SELECT id, substr(content, 1, instr(content, char(10)) - 1) AS goal_line
    FROM memory_entries
    WHERE tier = 'episodic' AND role = 'summary'
  `).all() as Array<{ id: string; goal_line: string }>

  const groups = new Map<string, Array<{ id: string }>>()
  for (const row of duplicates) {
    const group = groups.get(row.goal_line) ?? []
    group.push({ id: row.id })
    groups.set(row.goal_line, group)
  }

  let dupDeleted = 0
  for (const [, members] of groups) {
    if (members.length <= 1) continue
    const ordered = db.prepare(
      `SELECT id FROM memory_entries WHERE id IN (${members.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT 1`
    ).get(...members.map((m) => m.id)) as { id: string } | undefined
    if (!ordered) continue
    for (const { id } of members.filter((m) => m.id !== ordered.id)) {
      db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id)
      dupDeleted++
    }
  }

  return {
    deleted:
      (lowConf.changes ?? 0) +
      (failedWorking.changes ?? 0) +
      (staleAnswers.changes ?? 0) +
      (staleSemantic.changes ?? 0) +
      dupDeleted,
  }
}

export function getMemoryStats(opts?: { upn?: string | null }): {
  working: number
  episodic: number
  semantic: number
  procedural: number
  total: number
  vectors: number
  oldestMemory: string | null
} {
  const db = getDb()
  // Tenant scope: undefined → all tenants (admin); null → only legacy/global
  // pool; string → only that user's rows plus shared=1.
  const tenantClause = opts?.upn === undefined
    ? ""
    : opts.upn === null
      ? " WHERE (upn IS NULL OR shared = 1)"
      : " WHERE (upn = ? OR shared = 1)"
  const tenantParams: unknown[] = opts?.upn === undefined || opts.upn === null ? [] : [opts.upn]

  const counts = db.prepare(
    `SELECT tier, COUNT(*) as count FROM memory_entries${tenantClause} GROUP BY tier`
  ).all(...tenantParams) as Array<{ tier: string; count: number }>

  const procCount = db.prepare(
    `SELECT COUNT(*) as count FROM procedural_memories${tenantClause}`
  ).get(...tenantParams) as { count: number }

  const vecCount = db.prepare(
    `SELECT COUNT(*) as count FROM memory_vectors${
      opts?.upn === undefined ? "" : " WHERE entry_id IN (SELECT id FROM memory_entries" + tenantClause + ")"
    }`
  ).get(...tenantParams) as { count: number }

  const oldest = db.prepare(
    `SELECT MIN(created_at) as oldest FROM memory_entries${tenantClause}`
  ).get(...tenantParams) as { oldest: string | null }

  const byTier: Record<string, number> = {}
  for (const { tier, count } of counts) byTier[tier] = count

  return {
    working: byTier["working"] ?? 0,
    episodic: byTier["episodic"] ?? 0,
    semantic: byTier["semantic"] ?? 0,
    procedural: procCount.count,
    total: (byTier["working"] ?? 0) + (byTier["episodic"] ?? 0) + (byTier["semantic"] ?? 0) + procCount.count,
    vectors: vecCount.count,
    oldestMemory: oldest.oldest,
  }
}

export function getMemory(id: string): Memory | null {
  const row = getDb()
    .prepare("SELECT * FROM memory_entries WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined
  return row ? entryToLegacy(rowToEntry(row)) : null
}

export function listMemories(tier?: MemoryTier, limit = 50, opts?: { upn?: string | null }): Memory[] {
  const where: string[] = []
  const params: unknown[] = []
  if (tier) { where.push("tier = ?"); params.push(tier) }
  if (opts?.upn !== undefined) {
    if (opts.upn === null) where.push("(upn IS NULL OR shared = 1)")
    else { where.push("(upn = ? OR shared = 1)"); params.push(opts.upn) }
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  const sql = `SELECT * FROM memory_entries ${whereSql} ORDER BY updated_at DESC LIMIT ?`
  params.push(limit)
  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>
  return rows.map((r) => entryToLegacy(rowToEntry(r)))
}

export function deleteMemory(id: string): boolean {
  const result = getDb().prepare("DELETE FROM memory_entries WHERE id = ?").run(id)
  return (result.changes ?? 0) > 0
}

export function clearAllMemories(): void {
  const db = getDb()
  db.exec(`
    DELETE FROM memory_entries;
    DELETE FROM procedural_memories;
    DELETE FROM memory_vectors;
  `)
}
