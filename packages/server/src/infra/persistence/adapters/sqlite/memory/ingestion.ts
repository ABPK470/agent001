import { EventType, getCatalogSchemaFingerprint, RunStatus } from "@mia/agent"
import { randomUUID } from "node:crypto"
import {
  MemoryIngestionExclusionReason,
  MemoryRole,
  MemorySource,
  MemoryTier,
  EpisodicAnswerKind
} from "../../../../../internal/enums/memory.js"
import { broadcast } from "../../../../events/broadcaster.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runGetAsync, runExecAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"
import { stampProvenance } from "./provenance.js"
import { computeSalience, isDuplicate, SALIENCE_THRESHOLD, truncateAtBoundary } from "./scoring.js"
import { classifyEpisodicRun } from "./episodic-quality.js"
import {
  extractOrderedToolSequence
} from "./episodic-choreography.js"
import { extractGoalClasses } from "./goal-class.js"
import type { MemoryEntry } from "./types.js"
import { embedEntry } from "./vectors.js"

// ── Ingestion ────────────────────────────────────────────────────

/**
 * Ingest a single turn into memory.
 * Applies salience scoring and dedup before storing.
 * Returns the entry if stored, null if filtered out.
 */
export async function ingestTurn(opts: {
  tier: MemoryTier
  role: MemoryRole
  content: string
  metadata?: Record<string, unknown>
  source?: MemorySource
  confidence?: number
  runId?: string | null
  parentId?: string | null
  /** Owner UPN — required for tenant isolation; null for service/anonymous. */
  upn?: string | null
  /** Cross-user shared row (admin-curated). Defaults to false. */
  shared?: boolean
  /**
   * Override the default salience floor. Use a value below SALIENCE_THRESHOLD
   * to permit terse-but-valuable entries (e.g. agent-authored notes whose value
   * is in the subject identifier, not prose length). Pass 0 to disable the
   * floor entirely. Defaults to SALIENCE_THRESHOLD.
   */
  minSalience?: number
  /** Optional host — used to stamp the current catalog schema fingerprint. */
  host?: import("@mia/agent").AgentHost
}): Promise<MemoryEntry | null> {
  const salience = computeSalience(opts.content, opts.role)
  const floor = opts.minSalience ?? SALIENCE_THRESHOLD

  if (salience < floor && opts.role !== "system") {
    broadcast({
      type: EventType.MemoryFiltered,
      data: {
        reason: MemoryIngestionExclusionReason.LowSalience,
        salience,
        threshold: floor,
        tier: opts.tier,
        role: opts.role,
        contentPreview: opts.content.slice(0, 80)
      }
    })
    return null
  }

  // Dedup: check against recent entries for the same tenant (upn).
  const recentRowsQuery = getPlatformDb()
    .selectFrom("memory_entries")
    .select("content")
    .where((eb) =>
      opts.upn === null || opts.upn === undefined
        ? eb("upn", "is", null)
        : eb("upn", "=", opts.upn)
    )
    .orderBy("created_at", "desc")
    .limit(20)
    .compile()
  const recentRows = await runAllAsync<{ content: string }>(recentRowsQuery)

  if (
    isDuplicate(
      opts.content,
      recentRows.map((r) => r.content)
    )
  ) {
    broadcast({
      type: EventType.MemoryFiltered,
      data: {
        reason: MemoryIngestionExclusionReason.Duplicate,
        tier: opts.tier,
        role: opts.role,
        contentPreview: opts.content.slice(0, 80)
      }
    })
    return null
  }

  const now = platformNow()
  const entry: MemoryEntry = {
    id: randomUUID(),
    tier: opts.tier,
    role: opts.role,
    content: opts.content,
    metadata: stampProvenance(opts.metadata, {
      // null when no catalog is loaded (e.g. boot-time service ingests);
      // stampProvenance ignores undefined/empty values so legacy rows
      // remain neutral at retrieval time.
      schemaFingerprint: (opts.host ? getCatalogSchemaFingerprint(opts.host) : null) ?? undefined
    }),
    source: opts.source ?? MemorySource.Agent,
    confidence: opts.confidence ?? 0.5,
    salience,
    accessCount: 0,
    runId: opts.runId ?? null,
    parentId: opts.parentId ?? null,
    upn: opts.upn ?? null,
    shared: opts.shared ?? false,
    createdAt: now,
    updatedAt: now
  }

  const insertEntry = getPlatformDb()
    .insertInto("memory_entries")
    .values({
      id: entry.id,
      tier: entry.tier,
      role: entry.role,
      content: entry.content,
      metadata: JSON.stringify(entry.metadata),
      source: entry.source,
      confidence: entry.confidence,
      salience: entry.salience,
      access_count: entry.accessCount,
      run_id: entry.runId,
      parent_id: entry.parentId,
      upn: entry.upn,
      shared: entry.shared ? 1 : 0,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
    })
    .compile()
  await runExecAsync(insertEntry)

  // Optionally embed (async, non-blocking)
  embedEntry(entry).catch((err: unknown) => { console.error("[mia]", err) })

  broadcast({
    type: EventType.MemoryIngested,
    data: {
      id: entry.id,
      tier: entry.tier,
      role: entry.role,
      source: entry.source,
      runId: entry.runId,
      contentPreview: entry.content.slice(0, 200)
    }
  })

  return entry
}

/**
 * Ingest all significant turns from a completed run.
 * Called by the orchestrator after a run finishes.
 */
export async function ingestRunTurns(run: {
  id: string
  goal: string
  answer: string | null
  status: string
  tools: string[]
  stepCount: number
  error?: string | null
  trace: Array<{ kind: string; tool?: string; text?: string; argsSummary?: string; argsFormatted?: string }>
  /** Owner UPN — required; agent runs are authenticated-only. */
  upn: string
}): Promise<void> {
  const upn = run.upn.trim()
  if (!upn) return

  // 1. (goal text intentionally NOT stored in working memory — it is INPUT,
  //    not working state, and is already captured in episodic memory at step 4.
  //    Storing it here would pollute working memory with previous goal texts,
  //    which get retrieved by semantic similarity into future runs' system prompts.)

  // 2. Store significant tool calls and results.
  //
  // Tool result bodies are capped before they enter working memory.
  // Without a cap, an unbounded tool output (e.g. a catalog listing or
  // a search_catalog stats blob) lives in the conversation's working
  // memory forever, getting re-shipped on every subsequent retrieval
  // for the rest of the session — long after the model has moved on
  // and is no longer referencing it. The cap is generous (~6KB ≈ the
  // first useful page of any tool result); anything beyond that is
  // discoverable on demand via a fresh tool call, not via memory.
  const MAX_TOOL_RESULT_MEMORY_BYTES = 6000
  for (const t of run.trace) {
    if (t.kind === "tool-call" && t.tool && t.text) {
      await ingestTurn({
        tier: MemoryTier.Working,
        role: MemoryRole.Tool,
        content: `[Tool: ${t.tool}] ${truncateAtBoundary(t.text, MAX_TOOL_RESULT_MEMORY_BYTES, "\u2026 [truncated for memory]")}`,
        metadata: { type: "tool-call", tool: t.tool },
        source: MemorySource.Tool,
        confidence: 0.6,
        runId: run.id,
        upn
      })
    } else if (t.kind === "tool-result" && t.text) {
      await ingestTurn({
        tier: MemoryTier.Working,
        role: MemoryRole.Tool,
        content: truncateAtBoundary(t.text, MAX_TOOL_RESULT_MEMORY_BYTES, "\u2026 [truncated for memory]"),
        metadata: { type: "tool-result" },
        source: MemorySource.Tool,
        confidence: 0.6,
        runId: run.id,
        upn
      })
    }
  }

  // 3. Store the final answer in working memory — only for completed runs.
  //    Working memory is thread-scoped at retrieval (same thread_id + upn) and
  //    time-boxed (WORKING_SESSION_WINDOW_H). Follow-ups in the same thread see it;
  //    other threads and stale rows do not. Episodic upsert below is the long-lived record.
  if (run.answer && run.status === RunStatus.Completed) {
    await ingestTurn({
      tier: MemoryTier.Working,
      role: MemoryRole.Assistant,
      content: run.answer,
      metadata: { type: "answer", runId: run.id, status: run.status },
      source: MemorySource.Agent,
      confidence: 0.8,
      runId: run.id,
      upn
    })
  }

  // 4. Store a compact episodic summary — upsert by goal so repeated runs of the
  //    same goal don't accumulate contradictory entries in memory.

  // Auto-detect tool failures in the trace and record them as corrections so future
  // runs don't repeat the same failing approach (e.g. querying a non-existent table).
  const toolErrors: string[] = []
  for (const t of run.trace) {
    if (t.kind === "tool-error" && t.tool && t.text) {
      toolErrors.push(`${t.tool}: ${t.text.slice(0, 200)}`)
    } else if (t.kind === "tool-result" && t.text) {
      // Catch SQL Server "Invalid object name" / "does not exist" errors surfaced as results
      if (/invalid object name|does not exist|cannot find|object.*not found|no such table/i.test(t.text)) {
        const tool = t.tool ?? MemoryRole.Tool
        toolErrors.push(`${tool} result contained error: ${t.text.slice(0, 200)}`)
      }
    }
  }

  const classification = classifyEpisodicRun({
    answer: run.answer,
    status: run.status,
    tools: run.tools,
    trace: run.trace,
    hasCorrections: toolErrors.length > 0
  })
  const goalClasses = extractGoalClasses(run.goal)
  const toolSequence = classification.shortcutEligible ? extractOrderedToolSequence(run.trace) : []

  const lines = [`Goal: ${run.goal}`, `Status: ${run.status}`]
  lines.push(`Tools used: ${run.tools.join(", ")} (${run.stepCount} steps)`)
  if (run.answer) {
    const a = truncateAtBoundary(run.answer, 800, "\u2026")
    lines.push(`Answer: ${a}`)
  }
  if (run.error) lines.push(`Error: ${run.error}`)
  if (toolErrors.length > 0) {
    lines.push(`Corrections (do NOT repeat these approaches):`)
    for (const e of toolErrors) lines.push(`  - ${e}`)
  }

  const episodicContent = lines.join("\n")
  const episodicMeta = {
    goal: run.goal,
    tools: run.tools,
    stepCount: run.stepCount,
    status: run.status,
    hasCorrections: toolErrors.length > 0,
    answerKind: classification.answerKind,
    shortcutEligible: classification.shortcutEligible,
    ...(toolSequence.length >= 2 ? { toolSequence } : {}),
    ...(goalClasses.length > 0 ? { goalClasses, ftsGoalClasses: goalClasses.join(" ") } : {})
  }
  const episodicConfidence =
    toolErrors.length > 0
      ? 0.35
      : classification.answerKind === EpisodicAnswerKind.Substantive
        ? 0.7
        : 0.3

  const goalPrefix = `Goal: ${run.goal}\n`
  const existingEpisodic = await runGetAsync<{ id: string }>(
    getPlatformDb()
      .selectFrom("memory_entries")
      .select("id")
      .where("tier", "=", MemoryTier.Episodic)
      .where("role", "=", MemoryRole.Summary)
      .where("content", ">=", goalPrefix)
      .where("content", "<", `${goalPrefix}\uffff`)
      .where("upn", "=", upn)
      .orderBy("updated_at", "desc")
      .limit(1)
      .compile()
  )

  if (existingEpisodic) {
    // Update in place — keeps memory lean and avoids contradictory prior-failure entries
    await runExecAsync(
      getPlatformDb()
        .updateTable("memory_entries")
        .set({
          content: episodicContent,
          metadata: JSON.stringify(episodicMeta),
          confidence: episodicConfidence,
          salience: computeSalience(episodicContent, MemoryRole.Summary),
          run_id: run.id,
          upn,
          updated_at: platformNow()
        })
        .where("id", "=", existingEpisodic.id)
        .compile()
    )
  } else {
    await ingestTurn({
      tier: MemoryTier.Episodic,
      role: MemoryRole.Summary,
      content: episodicContent,
      metadata: episodicMeta,
      source: MemorySource.Agent,
      confidence: episodicConfidence,
      runId: run.id,
      upn
    })
  }
}

/**
 * Mark a run's episodic memory entry as unhelpful / incorrect.
 * Prepends a FEEDBACK block to the content and drops confidence to near-zero
 * so the entry is retrieved with very low weight in future runs.
 */
export async function flagRunMemory(runId: string, note?: string): Promise<boolean> {
  const row = await runGetAsync<{ id: string; content: string; confidence: number }>(
    getPlatformDb()
      .selectFrom("memory_entries")
      .select(["id", "content", "confidence"])
      .where("run_id", "=", runId)
      .where("tier", "=", MemoryTier.Episodic)
      .where("role", "=", MemoryRole.Summary)
      .orderBy("updated_at", "desc")
      .limit(1)
      .compile()
  )

  if (!row) return false

  const prefix =
    `FEEDBACK: User marked this answer as NOT useful${note ? ` — ${note}` : ""}. ` +
    `Do NOT reuse the approaches described below. Find a different strategy.\n`
  const updated = prefix + row.content
  await runExecAsync(
    getPlatformDb()
      .updateTable("memory_entries")
      .set({ content: updated, confidence: 0.05, salience: 0.1, updated_at: platformNow() })
      .where("id", "=", row.id)
      .compile()
  )
  return true
}

// ── Agent-authored notes (Gap 1) ─────────────────────────────────
//
// `ingestAgentNote` is the write-side of the otherwise read-only memory system
// exposed to the agent. It is called by the per-run wrapper of the `note` tool
// (see packages/server/src/runtime/tooling/registry.ts PER_RUN_FACTORIES).
//
// Design choices:
// - tier=working, role=summary: notes are session-hot but treated as canonical
//   like episodic summaries (the summary role exempts them from salience-based
//   rejection in ingestTurn).
// - confidence=0.85 when evidence is provided, else 0.75. Higher than tool
//   results (0.6) — the agent has made a deliberate statement — but capped
//   below system-derived episodic success (0.7 baseline can rise via
//   consolidation). Cross-session consolidation will promote recurring notes
//   to semantic tier with the existing pipeline.
// - Dedup is delegated to ingestTurn (Jaccard ≥0.86), so repeating the same
//   `(subject, claim)` in a session naturally collapses to one entry.

export interface AgentNoteInput {
  subject: string
  claim: string
  evidence?: string
  category?: string
  runId?: string | null
  upn?: string | null
}

export type AgentNoteResult =
  | { ok: true; id: string }
  | { ok: false; reason: "low_salience" | "duplicate" | "invalid_input" }

/**
 * Persist an agent-authored fact to working memory. Returns the new entry id
 * on success; otherwise a structured reason. Designed to be called from
 * tool-execution paths (the `note` tool, doctrine auto-notes) so the result
 * surfaces cleanly back to the LLM.
 */
export async function ingestAgentNote(input: AgentNoteInput): Promise<AgentNoteResult> {
  const subject = input.subject.trim()
  const claim = input.claim.trim()
  if (!subject || !claim) {
    return { ok: false, reason: "invalid_input" }
  }

  const category = input.category && input.category.trim() ? input.category.trim() : "observation"

  // Compose the content. Format is chosen so that FTS5 indexes the subject
  // verbatim (it appears as a discrete token) and downstream readers can
  // grep `[note:` to filter agent notes apart from regular working entries.
  const evidenceTail = input.evidence && input.evidence.trim() ? `\n  ev: ${input.evidence.trim()}` : ""
  const content = `[note:${category}] ${subject} — ${claim}${evidenceTail}`

  const entry = await ingestTurn({
    tier: MemoryTier.Working,
    // 'summary' role is exempt from the salience floor in ingestTurn, so even
    // a terse but valuable note ("pk = pkClient") is not rejected.
    role: MemoryRole.Summary,
    content,
    metadata: {
      type: "agent_note",
      category,
      subject
    },
    source: MemorySource.Agent,
    confidence: evidenceTail ? 0.85 : 0.75,
    runId: input.runId ?? null,
    upn: input.upn ?? null,
    // Notes derive value from their subject (a qualified name) rather than
    // prose length, so a short "join_path: A↔B on pkClient" should not be
    // rejected by the generic salience heuristic. Floor at 0.05 keeps truly
    // empty/garbage entries out.
    minSalience: 0.05
  })

  if (!entry) {
    // ingestTurn returns null only after broadcasting MemoryFiltered; the
    // reasons are LowSalience or Duplicate. We can't observe which here
    // without re-running the predicates, but the most common reason for a
    // summary-role rejection is duplicate (the salience floor doesn't apply
    // to summary role per the predicate in ingestTurn).
    return { ok: false, reason: "duplicate" }
  }
  return { ok: true, id: entry.id }
}
