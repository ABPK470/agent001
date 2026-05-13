import { randomUUID } from "node:crypto"
import { getDb } from "../db.js"
import { broadcast } from "../event-broadcaster.js"
import { computeSalience, isDuplicate, SALIENCE_THRESHOLD, truncateAtBoundary } from "./scoring.js"
import type { MemoryEntry, MemoryRole, MemorySource, MemoryTier } from "./types.js"
import { embedEntry } from "./vectors.js"

// ── Ingestion ────────────────────────────────────────────────────

/**
 * Ingest a single turn into memory.
 * Applies salience scoring and dedup before storing.
 * Returns the entry if stored, null if filtered out.
 */
export function ingestTurn(opts: {
  tier: MemoryTier
  role: MemoryRole
  content: string
  metadata?: Record<string, unknown>
  source?: MemorySource
  confidence?: number
  sessionId?: string | null
  runId?: string | null
  parentId?: string | null
  /** Owner UPN — required for tenant isolation; null for service/anonymous. */
  upn?: string | null
  /** Cross-user shared row (admin-curated). Defaults to false. */
  shared?: boolean
}): MemoryEntry | null {
  const salience = computeSalience(opts.content, opts.role)

  if (salience < SALIENCE_THRESHOLD && opts.role !== "system") {
    broadcast({
      type: "memory.filtered",
      data: {
        reason: "low-salience",
        salience,
        threshold: SALIENCE_THRESHOLD,
        tier: opts.tier,
        role: opts.role,
        contentPreview: opts.content.slice(0, 80),
      },
    })
    return null
  }

  // Dedup: check against recent entries (same session/run AND same tenant).
  // Without the upn predicate user A's entry could mask a near-identical
  // legitimate entry from user B.
  const recentRows = getDb().prepare(`
    SELECT content FROM memory_entries
    WHERE (session_id = ? OR run_id = ?)
      AND ((upn IS NULL AND ? IS NULL) OR upn = ?)
    ORDER BY created_at DESC LIMIT 20
  `).all(opts.sessionId ?? "", opts.runId ?? "", opts.upn ?? null, opts.upn ?? null) as Array<{ content: string }>

  if (isDuplicate(opts.content, recentRows.map((r) => r.content))) {
    broadcast({
      type: "memory.filtered",
      data: {
        reason: "duplicate",
        tier: opts.tier,
        role: opts.role,
        contentPreview: opts.content.slice(0, 80),
      },
    })
    return null
  }

  const now = new Date().toISOString()
  const entry: MemoryEntry = {
    id: randomUUID(),
    tier: opts.tier,
    role: opts.role,
    content: opts.content,
    metadata: opts.metadata ?? {},
    source: opts.source ?? "agent",
    confidence: opts.confidence ?? 0.5,
    salience,
    accessCount: 0,
    sessionId: opts.sessionId ?? null,
    runId: opts.runId ?? null,
    parentId: opts.parentId ?? null,
    upn: opts.upn ?? null,
    shared: opts.shared ?? false,
    createdAt: now,
    updatedAt: now,
  }

  getDb().prepare(`
    INSERT INTO memory_entries (id, tier, role, content, metadata, source, confidence, salience, access_count, session_id, run_id, parent_id, upn, shared, created_at, updated_at)
    VALUES (@id, @tier, @role, @content, @metadata, @source, @confidence, @salience, @access_count, @session_id, @run_id, @parent_id, @upn, @shared, @created_at, @updated_at)
  `).run({
    id: entry.id,
    tier: entry.tier,
    role: entry.role,
    content: entry.content,
    metadata: JSON.stringify(entry.metadata),
    source: entry.source,
    confidence: entry.confidence,
    salience: entry.salience,
    access_count: entry.accessCount,
    session_id: entry.sessionId,
    run_id: entry.runId,
    parent_id: entry.parentId,
    upn: entry.upn,
    shared: entry.shared ? 1 : 0,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  })

  // Optionally embed (async, non-blocking)
  embedEntry(entry).catch(() => {})

  broadcast({
    type: "memory.ingested",
    data: {
      id: entry.id,
      tier: entry.tier,
      role: entry.role,
      source: entry.source,
      runId: entry.runId,
      contentPreview: entry.content.slice(0, 200),
    },
  })

  return entry
}

/**
 * Ingest all significant turns from a completed run.
 * Called by the orchestrator after a run finishes.
 */
export function ingestRunTurns(run: {
  id: string
  goal: string
  answer: string | null
  status: string
  agentId: string | null
  tools: string[]
  stepCount: number
  error?: string | null
  trace: Array<{ kind: string; tool?: string; text?: string; argsSummary?: string; argsFormatted?: string }>
  /** Owner UPN — used to scope this run's memories to the originating user. */
  upn?: string | null
}): void {
  const sessionId = run.agentId ?? "default"
  const upn = run.upn ?? null

  // 1. (goal text intentionally NOT stored in working memory — it is INPUT,
  //    not working state, and is already captured in episodic memory at step 4.
  //    Storing it here would pollute working memory with previous goal texts,
  //    which get retrieved by semantic similarity into future runs' system prompts.)

  // 2. Store significant tool calls and results
  for (const t of run.trace) {
    if (t.kind === "tool-call" && t.tool && t.text) {
      ingestTurn({
        tier: "working",
        role: "tool",
        content: `[Tool: ${t.tool}] ${t.text}`,
        metadata: { type: "tool-call", tool: t.tool },
        source: "tool",
        confidence: 0.6,
        sessionId,
        runId: run.id,
        upn,
      })
    } else if (t.kind === "tool-result" && t.text) {
      ingestTurn({
        tier: "working",
        role: "tool",
        content: t.text,
        metadata: { type: "tool-result" },
        source: "tool",
        confidence: 0.6,
        sessionId,
        runId: run.id,
        upn,
      })
    }
  }

  // 3. Store the final answer in working memory — only for completed runs.
  //    Working memory is session-scoped by retrieval (WORKING_SESSION_WINDOW_H cutoff),
  //    so this answer is visible as hot context for follow-up questions in the same session
  //    (e.g. "now filter those top 3 by region") but won't surface in a run started hours later.
  //    The episodic upsert (step below) is the cross-session canonical record.
  if (run.answer && run.status === "completed") {
    ingestTurn({
      tier: "working",
      role: "assistant",
      content: run.answer,
      metadata: { type: "answer", runId: run.id, status: run.status },
      source: "agent",
      confidence: 0.8,
      sessionId,
      runId: run.id,
      upn,
    })
  }

  // 4. Store a compact episodic summary — upsert by goal so repeated runs of the
  //    same goal don't accumulate contradictory entries in memory.
  const lines = [`Goal: ${run.goal}`, `Status: ${run.status}`]
  lines.push(`Tools used: ${run.tools.join(", ")} (${run.stepCount} steps)`)
  if (run.answer) {
    const a = truncateAtBoundary(run.answer, 800, "\u2026")
    lines.push(`Answer: ${a}`)
  }
  if (run.error) lines.push(`Error: ${run.error}`)

  // Auto-detect tool failures in the trace and record them as corrections so future
  // runs don't repeat the same failing approach (e.g. querying a non-existent table).
  const toolErrors: string[] = []
  for (const t of run.trace) {
    if (t.kind === "tool-error" && t.tool && t.text) {
      toolErrors.push(`${t.tool}: ${t.text.slice(0, 200)}`)
    } else if (t.kind === "tool-result" && t.text) {
      // Catch SQL Server "Invalid object name" / "does not exist" errors surfaced as results
      if (/invalid object name|does not exist|cannot find|object.*not found|no such table/i.test(t.text)) {
        const tool = t.tool ?? "tool"
        toolErrors.push(`${tool} result contained error: ${t.text.slice(0, 200)}`)
      }
    }
  }
  if (toolErrors.length > 0) {
    lines.push(`Corrections (do NOT repeat these approaches):`)
    for (const e of toolErrors) lines.push(`  - ${e}`)
  }

  const episodicContent = lines.join("\n")
  const episodicMeta = { goal: run.goal, tools: run.tools, stepCount: run.stepCount, status: run.status, hasCorrections: toolErrors.length > 0 }
  // Lower confidence when tool errors were detected — the approach was flawed.
  const episodicConfidence = toolErrors.length > 0 ? 0.35 : run.status === "completed" ? 0.7 : 0.3

  // Check for an existing summary for the same goal scoped to this user
  // (or to the unowned/global pool if no upn). Tenant isolation: a different
  // user asking the same question must NOT collide with this row.
  // Use substr() not LIKE to avoid treating goal text as a SQL wildcard pattern.
  const goalPrefix = `Goal: ${run.goal}\n`
  const existingEpisodic = getDb().prepare(`
    SELECT id FROM memory_entries
    WHERE tier = 'episodic' AND role = 'summary'
      AND substr(content, 1, ?) = ?
      AND ((upn IS NULL AND ? IS NULL) OR upn = ?)
    ORDER BY updated_at DESC LIMIT 1
  `).get(goalPrefix.length, goalPrefix, upn, upn) as { id: string } | undefined

  if (existingEpisodic) {
    // Update in place — keeps memory lean and avoids contradictory prior-failure entries
    const now = new Date().toISOString()
    getDb().prepare(`
      UPDATE memory_entries
      SET content = ?, metadata = ?, confidence = ?, salience = ?, run_id = ?, upn = COALESCE(upn, ?), updated_at = ?
      WHERE id = ?
    `).run(
      episodicContent,
      JSON.stringify(episodicMeta),
      episodicConfidence,
      computeSalience(episodicContent, "summary"),
      run.id,
      upn,
      now,
      existingEpisodic.id,
    )
  } else {
    ingestTurn({
      tier: "episodic",
      role: "summary",
      content: episodicContent,
      metadata: episodicMeta,
      source: "agent",
      confidence: episodicConfidence,
      sessionId,
      runId: run.id,
      upn,
    })
  }
}

/**
 * Mark a run's episodic memory entry as unhelpful / incorrect.
 * Prepends a FEEDBACK block to the content and drops confidence to near-zero
 * so the entry is retrieved with very low weight in future runs.
 */
export function flagRunMemory(runId: string, note?: string): boolean {
  const row = getDb().prepare(
    `SELECT id, content, confidence FROM memory_entries
     WHERE run_id = ? AND tier = 'episodic' AND role = 'summary'
     ORDER BY updated_at DESC LIMIT 1`,
  ).get(runId) as { id: string; content: string; confidence: number } | undefined

  if (!row) return false

  const prefix = `FEEDBACK: User marked this answer as NOT useful${note ? ` — ${note}` : ""}. ` +
    `Do NOT reuse the approaches described below. Find a different strategy.\n`
  const updated = prefix + row.content
  const now = new Date().toISOString()
  getDb().prepare(
    `UPDATE memory_entries SET content = ?, confidence = 0.05, salience = 0.1, updated_at = ? WHERE id = ?`,
  ).run(updated, now, row.id)
  return true
}
