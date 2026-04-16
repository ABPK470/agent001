/**
 * Unified Memory System — agenc-core inspired 3-tier retrieval.
 *
 * Architecture:
 *   All context flows through ONE retrieval pipeline. No separate "history" pipe.
 *   Recent turns naturally surface via recency scoring. Old knowledge competes
 *   via relevance. Everything is a memory entry at a different age and confidence.
 *
 * Tiers (budget-weighted retrieval):
 *   1. Working  (34%) — raw turns from current/recent sessions (high recency)
 *   2. Episodic (22%) — session summaries, compacted fragments (medium age)
 *   3. Semantic (44%) — long-lived consolidated knowledge (high relevance)
 *
 * Plus:
 *   Procedural — tool sequences that worked, keyed by trigger text.
 *
 * Features:
 *   - Salience scoring on ingestion (skip noise like "ok", "thanks")
 *   - Near-duplicate detection (Jaccard >= 0.92 = skip)
 *   - Confidence decay (7-day half-life) with activation bonus (ACT-R inspired)
 *   - Hybrid search: FTS5 BM25 + optional vector embeddings (Ollama)
 *   - Unified retrieval: combined = relevance * (1 - w) + recency * w
 *   - Token-based consolidation pipeline (episodic -> semantic)
 *
 * Output format: <memory> XML tags injected into system prompt.
 */

import { createHash, randomUUID } from "node:crypto"
import { getDb } from "./db.js"
import { broadcast } from "./ws.js"

// ── Types ────────────────────────────────────────────────────────

export type MemoryTier = "working" | "episodic" | "semantic"
export type MemorySource = "system" | "tool" | "user" | "agent" | "external"
export type MemoryRole = "user" | "assistant" | "tool" | "system" | "summary"

export interface MemoryEntry {
  id: string
  tier: MemoryTier
  role: MemoryRole
  content: string
  metadata: Record<string, unknown>
  source: MemorySource
  confidence: number
  salience: number
  accessCount: number
  sessionId: string | null
  runId: string | null
  parentId: string | null
  createdAt: string
  updatedAt: string
}

export interface ProceduralMemory {
  id: string
  trigger: string
  toolSequence: Array<{ tool: string; argsPattern: Record<string, unknown> }>
  successCount: number
  failureCount: number
  runId: string
  createdAt: string
  updatedAt: string
}

export interface UnifiedSearchResult {
  entry: MemoryEntry
  relevance: number
  recency: number
  combined: number
}

export interface MemoryBudget {
  maxTokens: number
  maxItems: number
}

// ── Compat aliases (consumed by routes/memory.ts) ────────────────

/** @deprecated Use MemoryEntry */
export interface Memory {
  id: string
  tier: MemoryTier | "procedural"
  content: string
  metadata: Record<string, unknown>
  source: MemorySource
  confidence: number
  accessCount: number
  runId: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}


function entryToLegacy(e: MemoryEntry): Memory {
  return {
    id: e.id,
    tier: e.tier,
    content: e.content,
    metadata: e.metadata,
    source: e.source,
    confidence: e.confidence,
    accessCount: e.accessCount,
    runId: e.runId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    expiresAt: null,
  }
}

// ── Constants ────────────────────────────────────────────────────

const RECENCY_HALF_LIFE_H = 24
const DECAY_HALF_LIFE_DAYS = 7
const RECENCY_WEIGHT = 0.4
const SALIENCE_THRESHOLD = 0.15
/**
 * Working memory is scoped to an active session window.
 * Entries older than this are excluded from working-tier retrieval so that answers
 * from a conversation last week don't bleed into a fresh run today.
 * Episodic/semantic tiers are unaffected — they have their own decay mechanisms.
 */
const WORKING_SESSION_WINDOW_H = 4
const DEDUP_JACCARD_THRESHOLD = 0.86
/** Minimum combined score for a memory to be included in context. */
const RELEVANCE_THRESHOLD = 0.15
const DEFAULT_BUDGET: MemoryBudget = { maxTokens: 3000, maxItems: 15 }

const TIER_BUDGET: Record<MemoryTier, number> = {
  working: 0.34,
  episodic: 0.22,
  semantic: 0.44,
}

const SOURCE_WEIGHT: Record<MemorySource, number> = {
  system: 1.0,
  tool: 0.85,
  user: 0.7,
  agent: 0.55,
  external: 0.4,
}

// ── Salience scoring ─────────────────────────────────────────────

const ACTION_KEYWORDS = new Set([
  "create", "created", "build", "built", "deploy", "deployed",
  "fix", "fixed", "debug", "debugged", "implement", "implemented",
  "decide", "decided", "configure", "configured", "install", "installed",
  "write", "wrote", "delete", "deleted", "update", "updated",
  "run", "execute", "test", "tested", "refactor", "refactored",
  "error", "failed", "success", "completed", "migrate", "migrated",
])

function computeSalience(content: string, role: MemoryRole): number {
  if (role === "system") return 0.8

  const len = content.length
  const lengthScore = Math.min(1, len / 200) * 0.35

  const words = content.toLowerCase().split(/\s+/)
  const actionHits = words.filter((w) => ACTION_KEYWORDS.has(w)).length
  const actionScore = Math.min(1, actionHits / 3) * 0.40

  let structureScore = 0
  if (/```/.test(content)) structureScore += 0.4
  if (/\/[\w.-]+\/[\w.-]+/.test(content)) structureScore += 0.3
  if (/https?:\/\//.test(content)) structureScore += 0.15
  if (/\b\w+\.\w{1,4}\b/.test(content)) structureScore += 0.15
  structureScore = Math.min(1, structureScore) * 0.25

  return lengthScore + actionScore + structureScore
}

// ── Text truncation ──────────────────────────────────────────────

/** Truncate text at the last complete line boundary within maxLen. */
function truncateAtBoundary(text: string, maxLen: number, suffix = ""): string {
  if (text.length <= maxLen) return text
  // Find the last newline before maxLen
  const lastNewline = text.lastIndexOf("\n", maxLen)
  if (lastNewline > maxLen * 0.5) {
    return text.slice(0, lastNewline) + suffix
  }
  // Fallback: last sentence-ending punctuation
  const lastSentence = Math.max(
    text.lastIndexOf(". ", maxLen),
    text.lastIndexOf("! ", maxLen),
    text.lastIndexOf("? ", maxLen),
  )
  if (lastSentence > maxLen * 0.5) {
    return text.slice(0, lastSentence + 1) + suffix
  }
  // Last resort: last space
  const lastSpace = text.lastIndexOf(" ", maxLen)
  if (lastSpace > maxLen * 0.5) {
    return text.slice(0, lastSpace) + suffix
  }
  return text.slice(0, maxLen) + suffix
}

// ── Deduplication ────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter((t) => t.length > 2))
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  return intersection / (a.size + b.size - intersection)
}

function isDuplicate(content: string, recentContents: string[]): boolean {
  const tokens = tokenize(content)
  for (const rc of recentContents) {
    if (jaccardSimilarity(tokens, tokenize(rc)) >= DEDUP_JACCARD_THRESHOLD) return true
  }
  return false
}

// ── Recency & Decay ──────────────────────────────────────────────

function recencyScore(createdAt: string, now: Date = new Date()): number {
  const ageMs = now.getTime() - new Date(createdAt).getTime()
  const ageH = ageMs / (1000 * 60 * 60)
  return Math.exp(-ageH / RECENCY_HALF_LIFE_H)
}

function confidenceDecay(createdAt: string, now: Date = new Date()): number {
  const ageMs = now.getTime() - new Date(createdAt).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS)
}

/**
 * ACT-R inspired activation (agenc-core pattern).
 * Frequently accessed + recently accessed memories stay most relevant.
 *
 * activation = (1 + log(accessCount + 1)) / 7 × accessRecency
 * accessRecency is 1.0 for just-accessed, decays exponentially.
 */
function activationBonus(accessCount: number, updatedAt?: string, now?: Date): number {
  const base = (1 + Math.log(accessCount + 1)) / 7
  if (!updatedAt) return base
  const ageMs = (now ?? new Date()).getTime() - new Date(updatedAt).getTime()
  const ageH = ageMs / (1000 * 60 * 60)
  const accessRecency = Math.exp(-ageH / (RECENCY_HALF_LIFE_H * 2)) // Slower decay for activation
  return base * (0.5 + 0.5 * accessRecency) // Blend base + recency
}

// ── Schema migration ─────────────────────────────────────────────

export function migrateMemory(): void {
  const db = getDb()

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL CHECK (tier IN ('working', 'episodic', 'semantic')),
      role TEXT NOT NULL DEFAULT 'assistant',
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'agent',
      confidence REAL NOT NULL DEFAULT 0.5,
      salience REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      run_id TEXT,
      parent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_me_tier ON memory_entries(tier);
    CREATE INDEX IF NOT EXISTS idx_me_session ON memory_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_me_run ON memory_entries(run_id);
    CREATE INDEX IF NOT EXISTS idx_me_created ON memory_entries(created_at);

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

    CREATE TABLE IF NOT EXISTS memory_vectors (
      entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      dimension INTEGER NOT NULL
    );
  `)

  // FTS5 for memory_entries
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
        content,
        metadata,
        content='memory_entries',
        content_rowid='rowid'
      );
    `)
  } catch { /* already exists */ }

  // FTS5 for procedural
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS procedural_fts USING fts5(
        trigger,
        content='procedural_memories',
        content_rowid='rowid'
      );
    `)
  } catch { /* already exists */ }

  // Sync triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS me_fts_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;

    CREATE TRIGGER IF NOT EXISTS me_fts_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
    END;

    CREATE TRIGGER IF NOT EXISTS me_fts_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
      INSERT INTO memory_entries_fts(rowid, content, metadata)
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

  // Migrate data from old 'memories' table if it exists
  try {
    const oldExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
    ).get()
    if (oldExists) {
      db.exec(`
        INSERT OR IGNORE INTO memory_entries (id, tier, role, content, metadata, source, confidence, salience, access_count, session_id, run_id, parent_id, created_at, updated_at)
        SELECT id,
               CASE WHEN tier = 'procedural' THEN 'episodic' ELSE tier END,
               'assistant',
               content,
               metadata,
               source,
               confidence,
               0.5,
               access_count,
               NULL,
               run_id,
               NULL,
               created_at,
               updated_at
        FROM memories;

        DROP TABLE IF EXISTS memories_fts;
        DROP TABLE IF EXISTS memories;
      `)
    }
  } catch { /* migration already done or table doesn't exist */ }
}

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

  // Dedup: check against recent entries (same session/run)
  const recentRows = getDb().prepare(`
    SELECT content FROM memory_entries
    WHERE (session_id = ? OR run_id = ?)
    ORDER BY created_at DESC LIMIT 20
  `).all(opts.sessionId ?? "", opts.runId ?? "") as Array<{ content: string }>

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
    createdAt: now,
    updatedAt: now,
  }

  getDb().prepare(`
    INSERT INTO memory_entries (id, tier, role, content, metadata, source, confidence, salience, access_count, session_id, run_id, parent_id, created_at, updated_at)
    VALUES (@id, @tier, @role, @content, @metadata, @source, @confidence, @salience, @access_count, @session_id, @run_id, @parent_id, @created_at, @updated_at)
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
  trace: Array<{ kind: string; tool?: string; text?: string; argsSummary?: string }>
}): void {
  const sessionId = run.agentId ?? "default"

  // 1. Store the user's goal
  ingestTurn({
    tier: "working",
    role: "user",
    content: run.goal,
    metadata: { type: "goal", runId: run.id },
    source: "user",
    confidence: 0.8,
    sessionId,
    runId: run.id,
  })

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

  const episodicContent = lines.join("\n")
  const episodicMeta = { goal: run.goal, tools: run.tools, stepCount: run.stepCount, status: run.status }
  const episodicConfidence = run.status === "completed" ? 0.7 : 0.3

  // Check for an existing summary for the same goal across ALL sessions.
  // Session-scoped upsert would allow the same goal to accumulate one entry per
  // session-id restart, filling episodic memory with contradictory completed answers.
  // Use substr() not LIKE to avoid treating goal text as a SQL wildcard pattern.
  const goalPrefix = `Goal: ${run.goal}\n`
  const existingEpisodic = getDb().prepare(`
    SELECT id FROM memory_entries
    WHERE tier = 'episodic' AND role = 'summary'
      AND substr(content, 1, ?) = ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(goalPrefix.length, goalPrefix) as { id: string } | undefined

  if (existingEpisodic) {
    // Update in place — keeps memory lean and avoids contradictory prior-failure entries
    const now = new Date().toISOString()
    getDb().prepare(`
      UPDATE memory_entries
      SET content = ?, metadata = ?, confidence = ?, salience = ?, run_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      episodicContent,
      JSON.stringify(episodicMeta),
      episodicConfidence,
      computeSalience(episodicContent, "summary"),
      run.id,
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
    })
  }
}

// ── Procedural memory ────────────────────────────────────────────

export function storeProcedural(opts: {
  trigger: string
  toolSequence: Array<{ tool: string; argsPattern: Record<string, unknown> }>
  runId: string
}): ProceduralMemory {
  const now = new Date().toISOString()

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
  })
}

// ── Unified Retrieval Pipeline ───────────────────────────────────

/**
 * Retrieve context for a goal — single unified pipeline.
 *
 * Blends working memory (recent turns), episodic (summaries),
 * and semantic (long-lived knowledge) through one ranked list.
 *
 * Scoring: combined = relevance * (1 - w) + recency * w
 * Recent turns always win because recency ~ 1.0.
 */
export async function retrieveContext(
  goal: string,
  opts?: {
    sessionId?: string
    runId?: string
    budget?: MemoryBudget
  },
): Promise<{
  context: string
  results: UnifiedSearchResult[]
  perTier: { working: string; episodic: string; semantic: string }
}> {
  const budget = opts?.budget ?? DEFAULT_BUDGET
  const now = new Date()
  const allResults: UnifiedSearchResult[] = []

  // Search each tier with its budget weight
  for (const tier of ["working", "episodic", "semantic"] as MemoryTier[]) {
    const tierBudget: MemoryBudget = {
      maxTokens: Math.floor(budget.maxTokens * TIER_BUDGET[tier]),
      maxItems: Math.floor(budget.maxItems * TIER_BUDGET[tier]),
    }

    const results = await searchEntries(goal, {
      tier,
      budget: tierBudget,
      sessionId: tier === "working" ? opts?.sessionId : undefined,
      excludeRunId: opts?.runId,
    })
    allResults.push(...results)
  }

  // Also search procedural memories (kept for activation tracking, but not injected into prompt)
  const procedures = searchProcedures(goal, 3)

  // Sort all results by combined score descending
  allResults.sort((a, b) => b.combined - a.combined)

  // Cross-tier deduplication: if the same content got promoted from
  // working → episodic → semantic, only keep the highest-scoring copy.
  const deduped: UnifiedSearchResult[] = []
  const seenContent = new Map<string, number>() // tokenized content hash → index in deduped
  for (const r of allResults) {
    // Skip entries below relevance threshold (prevents irrelevant memories)
    if (r.combined < RELEVANCE_THRESHOLD) continue

    const tokens = tokenize(r.entry.content)
    let isDup = false
    for (const [hash] of seenContent) {
      if (jaccardSimilarity(tokens, tokenize(hash)) >= DEDUP_JACCARD_THRESHOLD) {
        // Keep the higher-scored one (already in deduped since we sorted)
        isDup = true
        break
      }
    }
    if (!isDup) {
      seenContent.set(r.entry.content, deduped.length)
      deduped.push(r)
    }
  }

  // Pack within total token budget
  const packed: UnifiedSearchResult[] = []
  let tokenCount = 0
  for (const r of deduped) {
    const approxTokens = Math.ceil(r.entry.content.length / 4)
    if (tokenCount + approxTokens > budget.maxTokens) break
    if (packed.length >= budget.maxItems) break
    tokenCount += approxTokens
    packed.push(r)
  }

  // Bump access counts
  if (packed.length > 0) {
    const ids = packed.map((r) => r.entry.id)
    const placeholders = ids.map(() => "?").join(", ")
    getDb().prepare(
      `UPDATE memory_entries SET access_count = access_count + 1, updated_at = ? WHERE id IN (${placeholders})`
    ).run(now.toISOString(), ...ids)
  }

  const context = formatMemoryContext(packed, procedures)

  // Also produce per-tier formatted content for structured prompt assembly
  const workingItems = packed.filter((r) => r.entry.tier === "working")
  const episodicItems = packed.filter((r) => r.entry.tier === "episodic")
  const semanticItems = packed.filter((r) => r.entry.tier === "semantic")

  const perTier = {
    working: workingItems.length > 0
      ? workingItems.map((r) => r.entry.content).join("\n")
      : "",
    episodic: episodicItems.length > 0
      ? episodicItems.map((r) => r.entry.content).join("\n")
      : "",
    semantic: semanticItems.length > 0
      ? semanticItems.map((r) => r.entry.content).join("\n")
      : "",
  }

  broadcast({
    type: "memory.retrieved",
    data: {
      total: packed.length,
      working: workingItems.length,
      episodic: episodicItems.length,
      semantic: semanticItems.length,
      procedural: procedures.length,
      runId: opts?.runId ?? null,
    },
  })

  return { context, results: packed, perTier }
}

/**
 * Search memory entries with hybrid FTS5 + vector relevance scoring.
 * When Ollama embeddings are available, blends keyword (FTS5 BM25) and
 * semantic (cosine similarity) results for true hybrid search.
 */
export async function searchEntries(
  query: string,
  opts: {
    tier?: MemoryTier
    budget: MemoryBudget
    sessionId?: string
    excludeRunId?: string
  },
): Promise<UnifiedSearchResult[]> {
  const now = new Date()

  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) {
    if (opts.tier === "working") {
      return getRecentEntries(opts.tier, opts.budget.maxItems, opts.sessionId)
    }
    return []
  }

  let sql = `
    SELECT e.*, memory_entries_fts.rank AS fts_rank
    FROM memory_entries e
    JOIN memory_entries_fts ON e.rowid = memory_entries_fts.rowid
    WHERE memory_entries_fts MATCH ?
  `
  const params: unknown[] = [ftsQuery]

  if (opts.tier) {
    sql += " AND e.tier = ?"
    params.push(opts.tier)
  }
  if (opts.excludeRunId) {
    sql += " AND (e.run_id IS NULL OR e.run_id != ?)"
    params.push(opts.excludeRunId)
  }
  if (opts.sessionId && opts.tier === "working") {
    sql += " AND e.session_id = ?"
    params.push(opts.sessionId)
  }
  if (opts.tier === "working") {
    // Hard cutoff: working memory only surfaces entries from the active session window.
    // This prevents stale answers from previous sessions bleeding into a fresh run.
    // The RECENCY_HALF_LIFE decay alone is not sufficient — entries with accessCount > 0
    // get an ACT-R activation bonus that keeps them alive across session boundaries.
    const windowCutoff = new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
    sql += " AND e.created_at > ?"
    params.push(windowCutoff)
  }

  sql += " ORDER BY fts_rank LIMIT ?"
  params.push(opts.budget.maxItems * 3)

  const rows = getDb().prepare(sql).all(...params) as Array<
    Record<string, unknown> & { fts_rank: number }
  >

  // For working tier, also get recent entries that may not match FTS
  let recentEntries: UnifiedSearchResult[] = []
  if (opts.tier === "working") {
    recentEntries = getRecentEntries("working", 12, opts.sessionId)
  }

  const ftsResults: UnifiedSearchResult[] = rows.map((row) => {
    const entry = rowToEntry(row)
    const rawRank = Math.abs(row.fts_rank)
    // Down-weight failed/incomplete entries so they don't poison future runs.
    // Applies to both episodic summaries (confidence 0.3) and working-tier agent
    // answers from prior failed runs (confidence 0.4). Completed entries are unaffected.
    const isFailedEntry =
      entry.confidence < 0.5 &&
      (entry.tier === "episodic" || (entry.tier === "working" && entry.role === "assistant"))
    const statusPenalty = isFailedEntry ? 0.4 : 1.0
    const normRelevance = Math.min(1, rawRank * SOURCE_WEIGHT[entry.source] * entry.confidence * statusPenalty)
    const rec = recencyScore(entry.createdAt, now)
    const decay = confidenceDecay(entry.createdAt, now)
    const activation = activationBonus(entry.accessCount, entry.updatedAt, now)
    const relevance = normRelevance * decay * activation
    const combined = relevance * (1 - RECENCY_WEIGHT) + rec * RECENCY_WEIGHT

    return { entry, relevance, recency: rec, combined }
  })

  // ── Vector search: blend semantic matches when embeddings exist ──
  // This catches cases like "revenue" matching a memory about "sales totals"
  // that FTS5 keyword matching would miss entirely.
  const vecResults = await vectorSearch(query, opts.budget.maxItems * 2, opts.tier)
  if (vecResults.length > 0) {
    const ftsIds = new Set(ftsResults.map((r) => r.entry.id))
    for (const vr of vecResults) {
      if (ftsIds.has(vr.entryId)) continue // already have this from FTS
      if (vr.similarity < 0.5) continue     // skip weak matches

      const row = getDb().prepare("SELECT * FROM memory_entries WHERE id = ?").get(vr.entryId) as Record<string, unknown> | undefined
      if (!row) continue
      if (opts.excludeRunId && row.run_id === opts.excludeRunId) continue
      if (opts.sessionId && opts.tier === "working" && row.session_id !== opts.sessionId) continue

      const entry = rowToEntry(row)
      const rec = recencyScore(entry.createdAt, now)
      const decay = confidenceDecay(entry.createdAt, now)
      const activation = activationBonus(entry.accessCount, entry.updatedAt, now)
      // Use vector similarity as the relevance signal
      const relevance = vr.similarity * SOURCE_WEIGHT[entry.source] * decay * activation
      const combined = relevance * (1 - RECENCY_WEIGHT) + rec * RECENCY_WEIGHT

      ftsResults.push({ entry, relevance, recency: rec, combined })
      ftsIds.add(vr.entryId)
    }
  }

  // Merge with recent entries, deduplicate by ID
  const seen = new Set(ftsResults.map((r) => r.entry.id))
  for (const r of recentEntries) {
    if (!seen.has(r.entry.id)) {
      ftsResults.push(r)
      seen.add(r.entry.id)
    }
  }

  ftsResults.sort((a, b) => b.combined - a.combined)

  const packed: UnifiedSearchResult[] = []
  let tokenCount = 0
  for (const r of ftsResults) {
    const approxTokens = Math.ceil(r.entry.content.length / 4)
    if (tokenCount + approxTokens > opts.budget.maxTokens) break
    if (packed.length >= opts.budget.maxItems) break
    tokenCount += approxTokens
    packed.push(r)
  }

  return packed
}

function getRecentEntries(
  tier: MemoryTier,
  limit: number,
  sessionId?: string,
): UnifiedSearchResult[] {
  const now = new Date()
  let sql = "SELECT * FROM memory_entries WHERE tier = ?"
  const params: unknown[] = [tier]

  if (sessionId) {
    sql += " AND session_id = ?"
    params.push(sessionId)
  }
  if (tier === "working") {
    const windowCutoff = new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
    sql += " AND created_at > ?"
    params.push(windowCutoff)
  }

  sql += " ORDER BY created_at DESC LIMIT ?"
  params.push(limit)

  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>

  return rows.map((row) => {
    const entry = rowToEntry(row)
    const rec = recencyScore(entry.createdAt, now)
    return {
      entry,
      relevance: entry.confidence * activationBonus(entry.accessCount, entry.updatedAt, now),
      recency: rec,
      combined: entry.confidence * 0.3 + rec * 0.7,
    }
  })
}

// ── Output formatting ────────────────────────────────────────────

function formatMemoryContext(
  results: UnifiedSearchResult[],
  _procedures: ProceduralMemory[],
): string {
  if (results.length === 0) return ""

  const blocks: string[] = []

  const working = results.filter((r) => r.entry.tier === "working")
  const episodic = results.filter((r) => r.entry.tier === "episodic")
  const semantic = results.filter((r) => r.entry.tier === "semantic")

  // Working memory — recent conversation turns (high recency, fresh context)
  if (working.length > 0) {
    blocks.push("<working_memory>")
    for (const r of working) {
      blocks.push(r.entry.content)
    }
    blocks.push("</working_memory>")
  }

  // Episodic memory — session summaries (medium age, pattern recognition)
  if (episodic.length > 0) {
    blocks.push("<episodic_memory>")
    for (const r of episodic) {
      blocks.push(r.entry.content)
    }
    blocks.push("</episodic_memory>")
  }

  // Semantic memory — long-lived consolidated knowledge
  if (semantic.length > 0) {
    blocks.push("<semantic_memory>")
    for (const r of semantic) {
      blocks.push(r.entry.content)
    }
    blocks.push("</semantic_memory>")
  }

  // Note: procedural memories (tool sequences) are intentionally excluded.
  // They consume tokens without improving LLM tool selection.

  return [
    "",
    "<memory_context>",
    ...blocks,
    "</memory_context>",
    "",
  ].join("\n")
}

// ── Vector embeddings (Ollama) ───────────────────────────────────

let ollamaAvailable: boolean | null = null

async function checkOllama(): Promise<boolean> {
  if (ollamaAvailable !== null) return ollamaAvailable
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2000) })
    ollamaAvailable = res.ok
  } catch {
    ollamaAvailable = false
  }
  return ollamaAvailable
}

async function getEmbedding(text: string): Promise<Float32Array | null> {
  if (!(await checkOllama())) return null
  try {
    const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", prompt: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json() as { embedding?: number[] }
    if (!data.embedding) return null
    return new Float32Array(data.embedding)
  } catch {
    return null
  }
}

async function embedEntry(entry: MemoryEntry): Promise<void> {
  const embedding = await getEmbedding(entry.content)
  if (!embedding) return

  getDb().prepare(`
    INSERT OR REPLACE INTO memory_vectors (entry_id, embedding, dimension)
    VALUES (?, ?, ?)
  `).run(entry.id, Buffer.from(embedding.buffer), embedding.length)
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

export async function vectorSearch(
  query: string,
  limit = 10,
  tier?: MemoryTier,
): Promise<Array<{ entryId: string; similarity: number }>> {
  const queryVec = await getEmbedding(query)
  if (!queryVec) return []

  let sql = `
    SELECT v.entry_id, v.embedding, v.dimension, e.tier
    FROM memory_vectors v
    JOIN memory_entries e ON e.id = v.entry_id
  `
  const params: unknown[] = []
  if (tier) {
    sql += " WHERE e.tier = ?"
    params.push(tier)
  }

  const rows = getDb().prepare(sql).all(...params) as Array<{
    entry_id: string; embedding: Buffer; dimension: number; tier: string
  }>

  const scored = rows.map((row) => {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension)
    return { entryId: row.entry_id, similarity: cosineSimilarity(queryVec, vec) }
  })

  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, limit)
}

// ── Consolidation pipeline (agenc-core pattern) ─────────────────
//
// Promotes repeated episodic/working patterns into long-lived semantic facts.
// Runs after each completed run (non-blocking) and as periodic background task.
//
// Pipeline:
//   1. Fetch recent episodic + old working entries past the lookback window
//   2. Agglomerative clustering by Jaccard token similarity (≥ 0.4)
//   3. Clusters with ≥ 2 entries → promotion candidates
//   4. Cross-tier dedup: check against existing semantic entries (Jaccard ≥ 0.86)
//   5. Promote with boosted confidence: 0.5 + clusterSize × 0.1 (capped at 0.95)
//   6. Soft-delete source entries (reduce confidence so they fade)

export function consolidate(opts?: {
  minAgeHours?: number
  maxBatchSize?: number
}): { promoted: number; pruned: number } {
  const minAgeHours = opts?.minAgeHours ?? 24
  const maxBatchSize = opts?.maxBatchSize ?? 200  // agenc-core uses 200
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000).toISOString()

  // Fetch candidates: episodic entries older than cutoff + old working entries.
  // Exclude role='summary' — these are canonical per-goal answer records (from ingestRunTurns).
  // They must NOT be clustered into semantic because:
  //   1. The content includes specific query results (client names, revenue figures)
  //      that change over time — merging two such entries produces a contradictory
  //      semantic "fact" with wrong answers from multiple different time periods.
  //   2. They are already deduplicated by the episodic upsert (one per goal) — there
  //      is no value in further consolidation.
  // Only working-tier tool-call/result turns (raw patterns) should be clustered.
  const candidates = getDb().prepare(`
    SELECT * FROM memory_entries
    WHERE (tier = 'episodic' OR (tier = 'working' AND created_at < ?))
      AND role != 'summary'
      AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(cutoff, cutoff, maxBatchSize) as Array<Record<string, unknown>>

  if (candidates.length < 3) return { promoted: 0, pruned: 0 }

  // Load existing semantic entries for cross-tier dedup
  const existingSemantic = getDb().prepare(`
    SELECT content FROM memory_entries WHERE tier = 'semantic'
    ORDER BY created_at DESC LIMIT 100
  `).all() as Array<{ content: string }>
  const semanticTokenSets = existingSemantic.map((s) => tokenize(s.content))

  // Agglomerative clustering by Jaccard ≥ 0.4
  const entries = candidates.map((r) => ({
    row: r,
    tokens: tokenize(r.content as string),
    clustered: false,
  }))

  const clusters: Array<Array<typeof entries[number]>> = []

  for (const entry of entries) {
    if (entry.clustered) continue
    const cluster = [entry]
    entry.clustered = true

    for (const other of entries) {
      if (other.clustered) continue
      if (jaccardSimilarity(entry.tokens, other.tokens) >= 0.4) {
        cluster.push(other)
        other.clustered = true
      }
    }
    clusters.push(cluster)
  }

  let promoted = 0
  let pruned = 0

  for (const cluster of clusters) {
    if (cluster.length < 2) continue

    const contents = cluster.map((c) => c.row.content as string)
    const merged = contents.join("\n---\n")
    const mergedTokens = tokenize(merged)

    // Cross-tier dedup: skip if this cluster duplicates an existing semantic entry
    const isDupOfSemantic = semanticTokenSets.some(
      (st) => jaccardSimilarity(mergedTokens, st) >= DEDUP_JACCARD_THRESHOLD,
    )
    if (isDupOfSemantic) {
      // Still soft-delete the source entries since their content is already in semantic
      const ids = cluster.map((c) => c.row.id as string)
      const placeholders = ids.map(() => "?").join(", ")
      getDb().prepare(
        `UPDATE memory_entries SET confidence = confidence * 0.3, updated_at = ? WHERE id IN (${placeholders})`
      ).run(new Date().toISOString(), ...ids)
      pruned += ids.length
      continue
    }

    // Boosted confidence: 0.5 + clusterSize × 0.1 (agenc-core formula, cap at 0.95)
    const confidence = Math.min(0.95, 0.5 + cluster.length * 0.1)

    ingestTurn({
      tier: "semantic",
      role: "summary",
      content: truncateAtBoundary(merged, 2000, "\n\u2026(consolidated)"),
      metadata: {
        sourceCount: cluster.length,
        provenance: "consolidation:episodic_promotion",
        consolidatedFrom: cluster.map((c) => c.row.id),
      },
      source: "system",
      confidence,
    })
    promoted++

    // Add to semantic set so later clusters in this batch also dedup
    semanticTokenSets.push(mergedTokens)

    // Soft-delete: reduce confidence so they fade naturally
    const ids = cluster.map((c) => c.row.id as string)
    const placeholders = ids.map(() => "?").join(", ")
    getDb().prepare(
      `UPDATE memory_entries SET confidence = confidence * 0.3, updated_at = ? WHERE id IN (${placeholders})`
    ).run(new Date().toISOString(), ...ids)
    pruned += ids.length
  }

  // Prune very low confidence entries
  const deleted = getDb().prepare(
    "DELETE FROM memory_entries WHERE confidence < 0.05 AND tier != 'semantic'"
  ).run()
  pruned += deleted.changes ?? 0

  if (promoted > 0 || pruned > 0) {
    broadcast({
      type: "memory.consolidated",
      data: { promoted, pruned },
    })
  }

  return { promoted, pruned }
}

// ── Search helpers ───────────────────────────────────────────────

export function searchProcedures(goal: string, limit = 5): ProceduralMemory[] {
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

function sanitizeFtsQuery(query: string): string {
  const cleaned = query
    .replace(/[*"():^{}[\]\\]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .trim()

  if (!cleaned) return ""

  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 20)

  if (tokens.length === 0) return ""

  return tokens.map((t) => `"${t}"`).join(" OR ")
}

// ── Maintenance ──────────────────────────────────────────────────

export function prune(): { deleted: number } {
  const db = getDb()

  // Remove entries below minimum confidence threshold
  const lowConf = db.prepare(
    "DELETE FROM memory_entries WHERE confidence < 0.05"
  ).run()

  // Delete accumulated failed working/assistant entries — these are failed-run answers
  // that were stored before the step-3 guard was added. They pollute working_memory
  // because recency keeps them in top-K even after the statusPenalty down-scores them.
  const failedWorking = db.prepare(
    "DELETE FROM memory_entries WHERE tier = 'working' AND role = 'assistant' AND confidence < 0.5"
  ).run()

  // Delete working-tier assistant entries that are older than the session window.
  // Answers within the window are valid hot context for follow-up questions; older ones
  // are no longer reachable by retrieval (the window cutoff in searchEntries/getRecentEntries
  // already blocks them) but this cleans them from storage so the DB doesn't grow unboundedly.
  const windowCutoff = new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
  const staleAnswers = db.prepare(
    "DELETE FROM memory_entries WHERE tier = 'working' AND role = 'assistant' AND created_at < ?"
  ).run(windowCutoff)

  // Delete semantic entries with role='summary' — these were incorrectly promoted from
  // episodic by the old consolidate() which did not exclude summary-role entries.
  // Goal-answer summaries belong in episodic only (one per goal, upserted). In semantic
  // they create long-lived contradictions: e.g. "top 3 clients = PICK N PAY" from a
  // Jan run persists in semantic even after March's correct answer is in episodic.
  const staleSemantic = db.prepare(
    "DELETE FROM memory_entries WHERE tier = 'semantic' AND role = 'summary'"
  ).run()

  // Collapse duplicate episodic goal summaries — keeps the most recently updated
  // one per goal-prefix across ALL sessions. Previously this was session-scoped,
  // which allowed one entry per session-id restart for the same goal.
  const duplicates = db.prepare(`
    SELECT id, substr(content, 1, instr(content, char(10)) - 1) AS goal_line
    FROM memory_entries
    WHERE tier = 'episodic' AND role = 'summary'
  `).all() as Array<{ id: string; goal_line: string }>

  // Group by goal_line only (cross-session), keep newest updated_at, delete the rest
  const groups = new Map<string, Array<{ id: string }>>()
  for (const row of duplicates) {
    const key = row.goal_line
    const group = groups.get(key) ?? []
    group.push({ id: row.id })
    groups.set(key, group)
  }

  let dupDeleted = 0
  for (const [, members] of groups) {
    if (members.length <= 1) continue
    // Find the keeper: the one with the most recent updated_at
    const ordered = db.prepare(
      `SELECT id FROM memory_entries WHERE id IN (${members.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT 1`
    ).get(...members.map((m) => m.id)) as { id: string } | undefined
    if (!ordered) continue
    const toDelete = members.filter((m) => m.id !== ordered.id)
    for (const { id } of toDelete) {
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

export function getMemoryStats(): {
  working: number
  episodic: number
  semantic: number
  procedural: number
  total: number
  vectors: number
  oldestMemory: string | null
} {
  const db = getDb()
  const counts = db.prepare(
    "SELECT tier, COUNT(*) as count FROM memory_entries GROUP BY tier"
  ).all() as Array<{ tier: string; count: number }>

  const procCount = db.prepare(
    "SELECT COUNT(*) as count FROM procedural_memories"
  ).get() as { count: number }

  const vecCount = db.prepare(
    "SELECT COUNT(*) as count FROM memory_vectors"
  ).get() as { count: number }

  const oldest = db.prepare(
    "SELECT MIN(created_at) as oldest FROM memory_entries"
  ).get() as { oldest: string | null }

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

export function listMemories(tier?: MemoryTier, limit = 50): Memory[] {
  const sql = tier
    ? "SELECT * FROM memory_entries WHERE tier = ? ORDER BY updated_at DESC LIMIT ?"
    : "SELECT * FROM memory_entries ORDER BY updated_at DESC LIMIT ?"
  const params = tier ? [tier, limit] : [limit]
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

// ── Row mappers ──────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    tier: row.tier as MemoryTier,
    role: (row.role as MemoryRole) ?? "assistant",
    content: row.content as string,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>) ?? {},
    source: (row.source as MemorySource) ?? "agent",
    confidence: (row.confidence as number) ?? 0.5,
    salience: (row.salience as number) ?? 0.5,
    accessCount: (row.access_count as number) ?? 0,
    sessionId: (row.session_id as string) ?? null,
    runId: (row.run_id as string) ?? null,
    parentId: (row.parent_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
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
