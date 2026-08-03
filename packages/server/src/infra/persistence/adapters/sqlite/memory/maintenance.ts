import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runChangesAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { rowToEntry } from "./schema.js"
import { WORKING_SESSION_WINDOW_H } from "./scoring.js"
import type { Memory, MemoryTier } from "./types.js"
import { entryToLegacy } from "./types.js"

// ── Maintenance ──────────────────────────────────────────────────

export async function prune(): Promise<{ deleted: number }> {
  const db = getPlatformDb()

  // Remove entries below minimum confidence threshold
  const lowConf = await runChangesAsync(db.deleteFrom("memory_entries").where("confidence", "<", 0.05).compile())

  // Delete accumulated failed working/assistant entries — these are failed-run answers
  // that were stored before the session-window guard was added.
  const failedWorking = await runChangesAsync(
    db.deleteFrom("memory_entries").where("tier", "=", "working").where("role", "=", "assistant").where("confidence", "<", 0.5).compile()
  )

  // Delete working-tier assistant entries that are older than the session window.
  // Answers within the window are valid hot context for follow-up questions; older ones
  // are no longer reachable by retrieval but this cleans them from storage so the DB
  // doesn't grow unboundedly.
  const windowCutoff = new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
  const staleAnswers = await runChangesAsync(
    db.deleteFrom("memory_entries").where("tier", "=", "working").where("role", "=", "assistant").where("created_at", "<", windowCutoff).compile()
  )

  // Delete semantic entries with role='summary' — these were incorrectly promoted from
  // episodic by an old consolidate() version that did not exclude summary-role entries.
  // Goal-answer summaries belong in episodic only (one per goal, upserted).
  const staleSemantic = await runChangesAsync(
    db.deleteFrom("memory_entries").where("tier", "=", "semantic").where("role", "=", "summary").compile()
  )

  // Collapse duplicate episodic goal summaries — keeps the most recently updated
  // one per goal-prefix across ALL sessions.
  const duplicates = await runAllAsync<{ id: string; content: string }>(
    db.selectFrom("memory_entries").select(["id", "content"]).where("tier", "=", "episodic").where("role", "=", "summary").compile()
  )

  const groups = new Map<string, Array<{ id: string }>>()
  for (const row of duplicates) {
    const goal_line = row.content.split("\n", 1)[0] ?? ""
    const group = groups.get(goal_line) ?? []
    group.push({ id: row.id })
    groups.set(goal_line, group)
  }

  let dupDeleted = 0
  for (const [, members] of groups) {
    if (members.length <= 1) continue
    const ordered = await runGetAsync<{ id: string }>(
      db.selectFrom("memory_entries").select("id").where("id", "in", members.map((m) => m.id)).orderBy("updated_at", "desc").limit(1).compile()
    )
    if (!ordered) continue
    for (const { id } of members.filter((m) => m.id !== ordered.id)) {
      await runExecAsync(db.deleteFrom("memory_entries").where("id", "=", id).compile())
      dupDeleted++
    }
  }

  return {
    deleted:
      lowConf + failedWorking + staleAnswers + staleSemantic +
      dupDeleted
  }
}

export async function getMemoryStats(opts?: { upn?: string | null }): Promise<{
  working: number
  episodic: number
  semantic: number
  total: number
  vectors: number
  oldestMemory: string | null
}> {
  const db = getPlatformDb()
  // Tenant scope: undefined → all tenants (admin); null → only legacy/global
  // pool; string → only that user's rows plus shared=1.
  let entries = db.selectFrom("memory_entries").selectAll()
  if (opts?.upn !== undefined) {
    const upn = opts.upn
    entries = entries.where((eb) => upn === null
      ? eb.or([eb("upn", "is", null), eb("shared", "=", 1)])
      : eb.or([eb("upn", "=", upn), eb("shared", "=", 1)]))
  }
  const rows = await runAllAsync<{ id: string; tier: string; created_at: string }>(entries.compile())
  const vectorRows = rows.length === 0
    ? []
    : await runAllAsync<{ entry_id: string }>(
      db.selectFrom("memory_vectors").select("entry_id").where("entry_id", "in", rows.map((row) => row.id)).compile()
    )

  const byTier: Record<string, number> = {}
  for (const row of rows) byTier[row.tier] = (byTier[row.tier] ?? 0) + 1

  return {
    working: byTier["working"] ?? 0,
    episodic: byTier["episodic"] ?? 0,
    semantic: byTier["semantic"] ?? 0,
    total: (byTier["working"] ?? 0) + (byTier["episodic"] ?? 0) + (byTier["semantic"] ?? 0),
    vectors: vectorRows.length,
    oldestMemory: rows.reduce<string | null>((oldest, row) => !oldest || row.created_at < oldest ? row.created_at : oldest, null)
  }
}

export async function getMemory(id: string): Promise<Memory | null> {
  const row = await runGetAsync<Record<string, unknown>>(getPlatformDb().selectFrom("memory_entries").selectAll().where("id", "=", id).compile())
  return row ? entryToLegacy(rowToEntry(row)) : null
}

export async function listMemories(tier?: MemoryTier, limit = 50, opts?: { upn?: string | null }): Promise<Memory[]> {
  let query = getPlatformDb().selectFrom("memory_entries").selectAll()
  if (tier) query = query.where("tier", "=", tier)
  if (opts?.upn !== undefined) {
    const upn = opts.upn
    query = query.where((eb) => upn === null
    ? eb.or([eb("upn", "is", null), eb("shared", "=", 1)])
    : eb.or([eb("upn", "=", upn), eb("shared", "=", 1)]))
  }
  const rows = await runAllAsync<Record<string, unknown>>(query.orderBy("updated_at", "desc").limit(limit).compile())
  return rows.map((r) => entryToLegacy(rowToEntry(r)))
}

export async function deleteMemory(id: string): Promise<boolean> {
  return (await runChangesAsync(getPlatformDb().deleteFrom("memory_entries").where("id", "=", id).compile())) > 0
}

export async function clearAllMemories(): Promise<void> {
  await runExecAsync(getPlatformDb().deleteFrom("memory_vectors").compile())
  await runExecAsync(getPlatformDb().deleteFrom("memory_entries").compile())
}
