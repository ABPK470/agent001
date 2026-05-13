import { createHash, randomUUID } from "node:crypto"
import { getDb } from "../db.js"
import { broadcast } from "../event-broadcaster.js"
import { sanitizeFtsQuery } from "./scoring.js"
import type { ProceduralMemory } from "./types.js"

// ── Procedural memory ────────────────────────────────────────────

function hashToolSequence(
  seq: Array<{ tool: string; argsPattern: Record<string, unknown> }>,
): string {
  const canonical = seq.map((s) => s.tool).join("|")
  return createHash("sha256").update(canonical).digest("hex")
}

function rowToProcedural(row: Record<string, unknown>): ProceduralMemory {
  return {
    id: row.id as string,
    trigger: row.trigger as string,
    toolSequence: JSON.parse(row.tool_sequence as string),
    successCount: row.success_count as number,
    failureCount: row.failure_count as number,
    runId: row.run_id as string,
    upn: (row.upn as string) ?? null,
    sessionId: (row.session_id as string) ?? null,
    shared: (row.shared as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function getProcedural(id: string): ProceduralMemory | null {
  const row = getDb()
    .prepare("SELECT * FROM procedural_memories WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined
  return row ? rowToProcedural(row) : null
}

export function storeProcedural(opts: {
  trigger: string
  toolSequence: Array<{ tool: string; argsPattern: Record<string, unknown> }>
  runId: string
  /** Owner UPN — scopes recall so different tenants do not share recipes. */
  upn?: string | null
  /** Originating session id (cookie sid). Optional. */
  sessionId?: string | null
  /** Cross-user shared recipe. Defaults to false. */
  shared?: boolean
}): ProceduralMemory {
  const now = new Date().toISOString()

  const seqHash = hashToolSequence(opts.toolSequence)
  // Per-tenant dedup: two users may legitimately have the same tool sequence
  // for the same trigger; we don't want a recipe written by user A to mask
  // user B's identical-but-tenant-private execution. Lookup is therefore
  // scoped by upn AND sequence-hash prefix. For temporary null-UPN sessions,
  // scope by sid so anonymous browsers do not share procedural recipes.
  const upn = opts.upn ?? null
  const existing = upn === null
    ? (opts.sessionId
      ? getDb().prepare(`
          SELECT id, success_count FROM procedural_memories
          WHERE id LIKE ? || '%'
            AND upn IS NULL
            AND session_id = ?
        `).get(seqHash.slice(0, 12), opts.sessionId)
      : getDb().prepare(`
          SELECT id, success_count FROM procedural_memories
          WHERE id LIKE ? || '%'
            AND upn IS NULL
            AND session_id IS NULL
        `).get(seqHash.slice(0, 12))) as { id: string; success_count: number } | undefined
    : getDb().prepare(`
        SELECT id, success_count FROM procedural_memories
        WHERE id LIKE ? || '%'
          AND upn = ?
      `).get(seqHash.slice(0, 12), upn) as { id: string; success_count: number } | undefined

  if (existing) {
    getDb().prepare(`
      UPDATE procedural_memories
      SET success_count = success_count + 1, updated_at = ?
      WHERE id = ?
    `).run(now, existing.id)
    return getProcedural(existing.id)!
  }

  const proc: ProceduralMemory = {
    id: randomUUID(),
    trigger: opts.trigger,
    toolSequence: opts.toolSequence,
    successCount: 1,
    failureCount: 0,
    runId: opts.runId,
    upn,
    sessionId: opts.sessionId ?? null,
    shared: opts.shared ?? false,
    createdAt: now,
    updatedAt: now,
  }

  getDb().prepare(`
    INSERT INTO procedural_memories (id, trigger, tool_sequence, success_count, failure_count, run_id, upn, session_id, shared, created_at, updated_at)
    VALUES (@id, @trigger, @tool_sequence, @success_count, @failure_count, @run_id, @upn, @session_id, @shared, @created_at, @updated_at)
  `).run({
    ...proc,
    tool_sequence: JSON.stringify(proc.toolSequence),
    success_count: proc.successCount,
    failure_count: proc.failureCount,
    run_id: proc.runId,
    upn: proc.upn,
    session_id: proc.sessionId,
    shared: proc.shared ? 1 : 0,
    created_at: proc.createdAt,
    updated_at: proc.updatedAt,
  })

  broadcast({
    type: "procedural.stored",
    data: {
      id: proc.id,
      trigger: proc.trigger,
      toolCount: proc.toolSequence.length,
      runId: proc.runId,
    },
  })

  return proc
}

export function markProceduralFailed(id: string): void {
  getDb().prepare(`
    UPDATE procedural_memories
    SET failure_count = failure_count + 1, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id)

  broadcast({
    type: "procedural.failed",
    data: { id },
  })
}

export function extractProcedural(run: {
  id: string
  goal: string
  trace: Array<{ kind: string; tool?: string; argsSummary?: string }>
  upn?: string | null
  sessionId?: string | null
}): ProceduralMemory | null {
  const toolCalls = run.trace
    .filter((t) => t.kind === "tool-call" && t.tool)
    .map((t) => ({
      tool: t.tool!,
      argsPattern: t.argsSummary ? { summary: t.argsSummary } : {},
    }))

  if (toolCalls.length < 2) return null

  return storeProcedural({
    trigger: run.goal,
    toolSequence: toolCalls,
    runId: run.id,
    upn: run.upn ?? null,
    sessionId: run.sessionId ?? null,
  })
}

export function searchProcedures(goal: string, limit = 5, upn?: string | null, sessionId?: string | null): ProceduralMemory[] {
  const ftsQuery = sanitizeFtsQuery(goal)
  if (!ftsQuery) return []

  // Tenant scope mirrors searchEntries: rows owned by the caller plus shared
  // recipes (admin-curated). For the temporary null-UPN path, sid scopes
  // private procedural memory so anonymous browsers do not share recipes.
  let tenantClause = ""
  const tenantParams: unknown[] = []
  if (upn !== undefined) {
    if (upn === null) {
      if (sessionId) {
        tenantClause = " AND ((p.upn IS NULL AND p.session_id = ?) OR p.shared = 1)"
        tenantParams.push(sessionId)
      } else {
        tenantClause = " AND p.shared = 1"
      }
    } else {
      tenantClause = " AND (p.upn = ? OR p.shared = 1)"
      tenantParams.push(upn)
    }
  }

  const rows = getDb().prepare(`
    SELECT p.*, procedural_fts.rank AS fts_rank
    FROM procedural_memories p
    JOIN procedural_fts ON p.rowid = procedural_fts.rowid
    WHERE procedural_fts MATCH ?${tenantClause}
    ORDER BY (CAST(p.success_count AS REAL) / MAX(p.success_count + p.failure_count, 1)) DESC,
             procedural_fts.rank ASC
    LIMIT ?
  `).all(ftsQuery, ...tenantParams, limit) as Array<Record<string, unknown>>

  return rows.map(rowToProcedural)
}
