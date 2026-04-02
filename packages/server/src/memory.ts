/**
 * Memory system — 3-tier persistent knowledge across agent runs.
 *
 * Tiers:
 *   1. Working  — last N messages from current thread (implicit in agent loop)
 *   2. Episodic — per-run summaries, compacted conversation fragments.
 *                 Auto-promoted to semantic after consolidation.
 *   3. Semantic — long-lived knowledge. FTS5-indexed. Confidence-scored.
 *                 Decays over time. Queryable by relevance.
 *
 * Plus:
 *   Procedural — recorded tool sequences that worked, keyed by trigger text.
 *                Low-effort, high-value: "last time this kind of goal came up,
 *                this tool sequence solved it."
 *
 * All backed by SQLite with FTS5 full-text search. No embeddings, no vector DB.
 */

import { createHash, randomUUID } from "node:crypto"
import { getDb } from "./db.js"

// ── Types ────────────────────────────────────────────────────────

export type MemoryTier = "episodic" | "semantic" | "procedural"
export type MemorySource = "system" | "tool" | "user" | "agent" | "external"

export interface Memory {
  id: string
  tier: MemoryTier
  content: string
  /** Structured metadata (JSON). Goal, tags, tool names, etc. */
  metadata: Record<string, unknown>
  /** Who/what produced this memory. Higher-source memories rank higher. */
  source: MemorySource
  /** Normalized 0–1 confidence. Decays over time, boosted by confirmations. */
  confidence: number
  /** How many times this memory was retrieved and used. */
  accessCount: number
  /** Associated run ID (if any). */
  runId: string | null
  createdAt: string
  updatedAt: string
  /** When this memory expires (null = no expiry). */
  expiresAt: string | null
}

export interface ProceduralMemory {
  id: string
  /** Natural-language trigger — what kind of goal activates this procedure. */
  trigger: string
  /** Ordered list of tool calls that succeeded. */
  toolSequence: Array<{ tool: string; argsPattern: Record<string, unknown> }>
  /** Number of times this procedure was successfully used. */
  successCount: number
  /** Number of times it was attempted but failed. */
  failureCount: number
  runId: string
  createdAt: string
  updatedAt: string
}

export interface MemorySearchResult {
  memory: Memory
  /** Relevance rank from FTS5 (lower = more relevant). */
  rank: number
  /** Final score after source weighting and temporal decay. */
  score: number
}

export interface MemoryBudget {
  /** Max tokens (approximate) to pack into the prompt. */
  maxTokens: number
  /** Max number of memories to return. */
  maxItems: number
}

const DEFAULT_BUDGET: MemoryBudget = { maxTokens: 2000, maxItems: 10 }

// ── Source weights (higher = more trusted) ───────────────────────

const SOURCE_WEIGHT: Record<MemorySource, number> = {
  system: 1.0,
  tool: 0.85,
  user: 0.7,
  agent: 0.55,
  external: 0.4,
}

// ── Temporal decay ───────────────────────────────────────────────

const DECAY_HALF_LIFE_DAYS = 7

function temporalDecay(createdAt: string, now: Date = new Date()): number {
  const ageMs = now.getTime() - new Date(createdAt).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS)
}

// ── Schema migration ─────────────────────────────────────────────

export function migrateMemory(): void {
  const db = getDb()

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL CHECK (tier IN ('episodic', 'semantic', 'procedural')),
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'agent',
      confidence REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
    CREATE INDEX IF NOT EXISTS idx_memories_run ON memories(run_id);
    CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);

    CREATE TABLE IF NOT EXISTS procedural_memories (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      tool_sequence TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  // FTS5 virtual table for full-text search across memory content
  // We use a content-sync'd FTS5 table that mirrors 'memories'
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        metadata,
        content='memories',
        content_rowid='rowid'
      );
    `)
  } catch {
    // FTS5 table already exists — that's fine
  }

  // FTS5 for procedural trigger matching
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS procedural_fts USING fts5(
        trigger,
        content='procedural_memories',
        content_rowid='rowid'
      );
    `)
  } catch {
    // Already exists
  }

  // Triggers to keep FTS in sync with base tables
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
      INSERT INTO memories_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;

    CREATE TRIGGER IF NOT EXISTS procedural_ai AFTER INSERT ON procedural_memories BEGIN
      INSERT INTO procedural_fts(rowid, trigger)
      VALUES (new.rowid, new.trigger);
    END;

    CREATE TRIGGER IF NOT EXISTS procedural_ad AFTER DELETE ON procedural_memories BEGIN
      INSERT INTO procedural_fts(procedural_fts, rowid, trigger)
      VALUES ('delete', old.rowid, old.trigger);
    END;

    CREATE TRIGGER IF NOT EXISTS procedural_au AFTER UPDATE ON procedural_memories BEGIN
      INSERT INTO procedural_fts(procedural_fts, rowid, trigger)
      VALUES ('delete', old.rowid, old.trigger);
      INSERT INTO procedural_fts(rowid, trigger)
      VALUES (new.rowid, new.trigger);
    END;
  `)
}

// ── Core operations ──────────────────────────────────────────────

/** Store a new memory. */
export function storeMemory(opts: {
  tier: MemoryTier
  content: string
  metadata?: Record<string, unknown>
  source?: MemorySource
  confidence?: number
  runId?: string | null
  expiresAt?: string | null
}): Memory {
  const now = new Date().toISOString()
  const memory: Memory = {
    id: randomUUID(),
    tier: opts.tier,
    content: opts.content,
    metadata: opts.metadata ?? {},
    source: opts.source ?? "agent",
    confidence: opts.confidence ?? 0.5,
    accessCount: 0,
    runId: opts.runId ?? null,
    createdAt: now,
    updatedAt: now,
    expiresAt: opts.expiresAt ?? null,
  }

  getDb().prepare(`
    INSERT INTO memories (id, tier, content, metadata, source, confidence, access_count, run_id, created_at, updated_at, expires_at)
    VALUES (@id, @tier, @content, @metadata, @source, @confidence, @access_count, @run_id, @created_at, @updated_at, @expires_at)
  `).run({
    ...memory,
    metadata: JSON.stringify(memory.metadata),
    access_count: memory.accessCount,
    run_id: memory.runId,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    expires_at: memory.expiresAt,
  })

  return memory
}

/** Store a procedural memory (successful tool sequence). */
export function storeProcedural(opts: {
  trigger: string
  toolSequence: Array<{ tool: string; argsPattern: Record<string, unknown> }>
  runId: string
}): ProceduralMemory {
  const now = new Date().toISOString()

  // Deduplicate: if we already have a procedure with the same tool sequence hash,
  // just bump its success count
  const seqHash = hashToolSequence(opts.toolSequence)
  const existing = getDb().prepare(`
    SELECT id, success_count FROM procedural_memories
    WHERE id LIKE ? || '%'
  `).get(seqHash.slice(0, 12)) as { id: string; success_count: number } | undefined

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
    createdAt: now,
    updatedAt: now,
  }

  getDb().prepare(`
    INSERT INTO procedural_memories (id, trigger, tool_sequence, success_count, failure_count, run_id, created_at, updated_at)
    VALUES (@id, @trigger, @tool_sequence, @success_count, @failure_count, @run_id, @created_at, @updated_at)
  `).run({
    ...proc,
    tool_sequence: JSON.stringify(proc.toolSequence),
    success_count: proc.successCount,
    failure_count: proc.failureCount,
    run_id: proc.runId,
    created_at: proc.createdAt,
    updated_at: proc.updatedAt,
  })

  return proc
}

/** Mark a procedural memory as failed (it was tried but didn't work). */
export function markProceduralFailed(id: string): void {
  getDb().prepare(`
    UPDATE procedural_memories
    SET failure_count = failure_count + 1, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id)
}

// ── Search ───────────────────────────────────────────────────────

/**
 * Search memories using FTS5 full-text search with relevance scoring.
 *
 * Scoring formula:
 *   score = fts5_rank × source_weight × temporal_decay × confidence × (1 + log(access_count + 1))
 *
 * Results are sorted by final score (highest first) and packed within the token budget.
 */
export function searchMemories(
  query: string,
  opts?: {
    tier?: MemoryTier
    budget?: MemoryBudget
    minConfidence?: number
    excludeRunId?: string
  },
): MemorySearchResult[] {
  const budget = opts?.budget ?? DEFAULT_BUDGET
  const minConfidence = opts?.minConfidence ?? 0.1
  const now = new Date()

  // Clean up expired memories first (lazy GC)
  getDb().prepare(`
    DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?
  `).run(now.toISOString())

  // FTS5 search with BM25 ranking
  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) return []

  let sql = `
    SELECT m.*, memories_fts.rank AS fts_rank
    FROM memories m
    JOIN memories_fts ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.confidence >= ?
  `
  const params: unknown[] = [ftsQuery, minConfidence]

  if (opts?.tier) {
    sql += " AND m.tier = ?"
    params.push(opts.tier)
  }
  if (opts?.excludeRunId) {
    sql += " AND (m.run_id IS NULL OR m.run_id != ?)"
    params.push(opts.excludeRunId)
  }

  sql += " ORDER BY fts_rank LIMIT ?"
  params.push(budget.maxItems * 3) // Fetch extra for scoring/filtering

  const rows = getDb().prepare(sql).all(...params) as Array<
    Record<string, unknown> & { fts_rank: number }
  >

  // Score and rank
  const results: MemorySearchResult[] = rows.map((row) => {
    const memory = rowToMemory(row)
    const rawRank = Math.abs(row.fts_rank) // FTS5 rank is negative (lower = better)
    const sourceW = SOURCE_WEIGHT[memory.source] ?? 0.5
    const decay = temporalDecay(memory.createdAt, now)
    const accessBoost = 1 + Math.log(memory.accessCount + 1)
    const score = rawRank * sourceW * decay * memory.confidence * accessBoost

    return { memory, rank: rawRank, score }
  })

  // Sort by score descending
  results.sort((a, b) => b.score - a.score)

  // Pack within token budget (approximate: 1 token ≈ 4 chars)
  const packed: MemorySearchResult[] = []
  let tokenCount = 0
  for (const r of results) {
    const approxTokens = Math.ceil(r.memory.content.length / 4)
    if (tokenCount + approxTokens > budget.maxTokens) break
    if (packed.length >= budget.maxItems) break
    tokenCount += approxTokens
    packed.push(r)
  }

  // Bump access count for returned memories
  if (packed.length > 0) {
    const ids = packed.map((r) => r.memory.id)
    const placeholders = ids.map(() => "?").join(", ")
    getDb().prepare(`
      UPDATE memories SET access_count = access_count + 1, updated_at = ?
      WHERE id IN (${placeholders})
    `).run(now.toISOString(), ...ids)
  }

  return packed
}

/**
 * Search procedural memories by goal/trigger text.
 * Returns procedures ranked by relevance × success rate.
 */
export function searchProcedures(
  goal: string,
  limit = 5,
): ProceduralMemory[] {
  const ftsQuery = sanitizeFtsQuery(goal)
  if (!ftsQuery) return []

  const rows = getDb().prepare(`
    SELECT p.*, procedural_fts.rank AS fts_rank
    FROM procedural_memories p
    JOIN procedural_fts ON p.rowid = procedural_fts.rowid
    WHERE procedural_fts MATCH ?
    ORDER BY (CAST(p.success_count AS REAL) / MAX(p.success_count + p.failure_count, 1)) DESC,
             procedural_fts.rank ASC
    LIMIT ?
  `).all(ftsQuery, limit) as Array<Record<string, unknown>>

  return rows.map(rowToProcedural)
}

// ── Run summary extraction ───────────────────────────────────────

/**
 * Extract and store an episodic memory from a completed run.
 *
 * Called by the orchestrator after a run completes. Summarizes:
 *   - What was the goal
 *   - What tools were used (in order)
 *   - What the outcome was
 *   - Key patterns (files touched, commands run, etc.)
 */
export function extractRunSummary(run: {
  id: string
  goal: string
  answer: string | null
  status: string
  tools: string[]
  stepCount: number
  error?: string | null
}): Memory {
  const lines = [`Goal: ${run.goal}`]
  lines.push(`Status: ${run.status}`)
  lines.push(`Tools used: ${run.tools.join(", ")} (${run.stepCount} steps)`)

  if (run.answer) {
    // Truncate long answers — episodic memory is a summary, not a transcript
    const answer = run.answer.length > 500 ? run.answer.slice(0, 500) + "…" : run.answer
    lines.push(`Answer: ${answer}`)
  }
  if (run.error) {
    lines.push(`Error: ${run.error}`)
  }

  // Episodic memories expire after 30 days (will be consolidated to semantic before then)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  return storeMemory({
    tier: "episodic",
    content: lines.join("\n"),
    metadata: {
      goal: run.goal,
      tools: run.tools,
      stepCount: run.stepCount,
      status: run.status,
    },
    source: "agent",
    confidence: run.status === "completed" ? 0.7 : 0.3,
    runId: run.id,
    expiresAt,
  })
}

/**
 * Extract and store procedural memory from a successful run's trace.
 *
 * Only stores if the run completed successfully and used 2+ tools.
 */
export function extractProcedural(run: {
  id: string
  goal: string
  trace: Array<{ kind: string; tool?: string; argsSummary?: string }>
}): ProceduralMemory | null {
  // Only worth recording if there was a meaningful tool sequence
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
  })
}

// ── Consolidation ────────────────────────────────────────────────

/**
 * Consolidation pipeline — promote episodic memories to semantic.
 *
 * Runs periodically. Finds episodic memories older than `minAgeHours`,
 * groups related ones, merges them into a single semantic memory,
 * and deletes the originals.
 *
 * Grouping is by metadata similarity (same tools, similar goals).
 */
export function consolidate(opts?: {
  minAgeHours?: number
  maxBatchSize?: number
}): { promoted: number; pruned: number } {
  const minAgeHours = opts?.minAgeHours ?? 24
  const maxBatchSize = opts?.maxBatchSize ?? 50
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000).toISOString()

  // Find episodic memories old enough to consolidate
  const candidates = getDb().prepare(`
    SELECT * FROM memories
    WHERE tier = 'episodic' AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(cutoff, maxBatchSize) as Array<Record<string, unknown>>

  if (candidates.length === 0) return { promoted: 0, pruned: 0 }

  // Group by tool set fingerprint (memories with same tools used → cluster)
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const row of candidates) {
    const meta = JSON.parse(row.metadata as string) as Record<string, unknown>
    const tools = (meta.tools as string[]) ?? []
    const key = tools.sort().join(",") || "_general"
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }

  let promoted = 0
  let pruned = 0

  for (const [toolKey, group] of groups) {
    // Merge group into a single semantic memory
    const contents = group.map((r) => r.content as string)
    const merged = contents.join("\n---\n")

    // Confidence is the max from the group, boosted slightly by having multiple sources
    const maxConfidence = Math.max(...group.map((r) => r.confidence as number))
    const confirmationBonus = Math.min(0.2, group.length * 0.05) // +5% per source, cap at +20%
    const confidence = Math.min(1.0, maxConfidence + confirmationBonus)

    storeMemory({
      tier: "semantic",
      content: merged.length > 2000 ? merged.slice(0, 2000) + "\n…(consolidated)" : merged,
      metadata: { toolKey, sourceCount: group.length, consolidatedFrom: group.map((r) => r.id) },
      source: "system",
      confidence,
    })
    promoted++

    // Delete the originals
    const ids = group.map((r) => r.id as string)
    const placeholders = ids.map(() => "?").join(", ")
    getDb().prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids)
    pruned += ids.length
  }

  return { promoted, pruned }
}

// ── Maintenance ──────────────────────────────────────────────────

/** Prune expired and low-confidence memories. */
export function prune(): { deleted: number } {
  const now = new Date().toISOString()

  // Delete expired memories
  const expired = getDb().prepare(`
    DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?
  `).run(now)

  // Delete very low confidence memories (confidence decayed below threshold)
  const lowConf = getDb().prepare(`
    DELETE FROM memories WHERE confidence < 0.05 AND tier != 'procedural'
  `).run()

  return { deleted: (expired.changes ?? 0) + (lowConf.changes ?? 0) }
}

/** Get memory statistics. */
export function getMemoryStats(): {
  episodic: number
  semantic: number
  procedural: number
  total: number
  oldestMemory: string | null
} {
  const db = getDb()
  const counts = db.prepare(`
    SELECT tier, COUNT(*) as count FROM memories GROUP BY tier
  `).all() as Array<{ tier: string; count: number }>

  const procCount = db.prepare(
    "SELECT COUNT(*) as count FROM procedural_memories"
  ).get() as { count: number }

  const oldest = db.prepare(
    "SELECT MIN(created_at) as oldest FROM memories"
  ).get() as { oldest: string | null }

  const byTier: Record<string, number> = {}
  for (const { tier, count } of counts) byTier[tier] = count

  return {
    episodic: byTier["episodic"] ?? 0,
    semantic: byTier["semantic"] ?? 0,
    procedural: procCount.count,
    total: (byTier["episodic"] ?? 0) + (byTier["semantic"] ?? 0) + procCount.count,
    oldestMemory: oldest.oldest,
  }
}

// ── Prompt injection (budget-aware packing) ──────────────────────

/**
 * Build a memory context block for injection into the system prompt.
 *
 * Searches for memories relevant to the goal, packs them within
 * the token budget, and formats them as a readable context block.
 */
export function buildMemoryContext(
  goal: string,
  budget?: MemoryBudget,
): string {
  const effectiveBudget = budget ?? DEFAULT_BUDGET
  const blocks: string[] = []

  // 1. Search semantic memories (highest value, longest lived)
  const semanticResults = searchMemories(goal, {
    tier: "semantic",
    budget: { maxTokens: Math.floor(effectiveBudget.maxTokens * 0.4), maxItems: 4 },
  })
  if (semanticResults.length > 0) {
    blocks.push("## Knowledge from past runs")
    for (const r of semanticResults) {
      blocks.push(`- ${r.memory.content.split("\n")[0]}`)
    }
  }

  // 2. Search episodic memories (recent run experiences)
  const episodicResults = searchMemories(goal, {
    tier: "episodic",
    budget: { maxTokens: Math.floor(effectiveBudget.maxTokens * 0.3), maxItems: 3 },
  })
  if (episodicResults.length > 0) {
    blocks.push("## Recent relevant runs")
    for (const r of episodicResults) {
      // Include all lines (Goal, Status, Tools, Answer) — don't truncate the answer
      blocks.push(`- ${r.memory.content.split("\n").join(" | ")}`)
    }
  }

  // 3. Search procedural memories (tool sequence suggestions)
  const procedures = searchProcedures(goal, 3)
  if (procedures.length > 0) {
    const useful = procedures.filter((p) => p.successCount > p.failureCount)
    if (useful.length > 0) {
      blocks.push("## Suggested tool approaches (worked before)")
      for (const p of useful) {
        const seq = p.toolSequence.map((s) => s.tool).join(" → ")
        const rate = Math.round((p.successCount / (p.successCount + p.failureCount)) * 100)
        blocks.push(`- ${seq} (${rate}% success rate, used ${p.successCount}×)`)
      }
    }
  }

  if (blocks.length === 0) return ""

  return [
    "",
    "--- Memory Context (from past experience) ---",
    ...blocks,
    "--- End Memory Context ---",
    "",
  ].join("\n")
}

// ── Helpers ──────────────────────────────────────────────────────

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    tier: row.tier as MemoryTier,
    content: row.content as string,
    metadata: JSON.parse(row.metadata as string),
    source: row.source as MemorySource,
    confidence: row.confidence as number,
    accessCount: (row.access_count as number) ?? 0,
    runId: (row.run_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: (row.expires_at as string) ?? null,
  }
}

function rowToProcedural(row: Record<string, unknown>): ProceduralMemory {
  return {
    id: row.id as string,
    trigger: row.trigger as string,
    toolSequence: JSON.parse(row.tool_sequence as string),
    successCount: row.success_count as number,
    failureCount: row.failure_count as number,
    runId: row.run_id as string,
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

function hashToolSequence(
  seq: Array<{ tool: string; argsPattern: Record<string, unknown> }>,
): string {
  const canonical = seq.map((s) => s.tool).join("|")
  return createHash("sha256").update(canonical).digest("hex")
}

/**
 * Sanitize a query for FTS5 — escape special characters and
 * convert natural language to OR-joined tokens for broader matching.
 */
function sanitizeFtsQuery(query: string): string {
  // Remove FTS5 operators and special chars
  const cleaned = query
    .replace(/[*"():^{}[\]\\]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .trim()

  if (!cleaned) return ""

  // Split into tokens, wrap each in quotes for exact matching, join with OR
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 1) // Drop single chars
    .slice(0, 20) // Limit tokens to prevent huge queries

  if (tokens.length === 0) return ""

  return tokens.map((t) => `"${t}"`).join(" OR ")
}

/** Get a specific memory by ID. */
export function getMemory(id: string): Memory | null {
  const row = getDb()
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined
  return row ? rowToMemory(row) : null
}

/** List all memories of a given tier. */
export function listMemories(tier?: MemoryTier, limit = 50): Memory[] {
  const sql = tier
    ? "SELECT * FROM memories WHERE tier = ? ORDER BY updated_at DESC LIMIT ?"
    : "SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?"
  const params = tier ? [tier, limit] : [limit]
  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>
  return rows.map(rowToMemory)
}

/** Delete a specific memory. */
export function deleteMemory(id: string): boolean {
  const result = getDb().prepare("DELETE FROM memories WHERE id = ?").run(id)
  return (result.changes ?? 0) > 0
}

/** Clear all memories (useful for reset). */
export function clearAllMemories(): void {
  const db = getDb()
  db.exec(`
    DELETE FROM memories;
    DELETE FROM procedural_memories;
  `)
}
