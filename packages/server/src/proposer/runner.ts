/**
 * F1 — Server-side proposer runner.
 *
 * Bridges the agent's pure `runProposerPass()` to the real DB by:
 *   • enumerating the entity registry for `tenantId`
 *   • calling `detectCatalogDrift()` against MSSQL
 *   • performing a sampled row-divergence probe via `previewSync(dryRun)`
 *     for each entity that has zero catalog drift
 *
 * Then persists the resulting findings (idempotent dedup by fingerprint)
 * and ranks the queue in-place.
 */

import {
    annotateProposal,
    detectCatalogDrift,
    emptyCounts,
    rankProposals,
    runProposerPass,
    tryResolveRecipe,
    type AgentHost,
    type EntityDescriptor,
    type EnvPair,
    type LlmCompletionPort,
    type ProposerFinding,
    type ProposerPassDeps,
    type ProposerPassOptions,
    type ProposerPassResult,
    type RankableProposal,
} from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import { listEntityDefinitions } from "../db/entity-defs.js"
import {
    createProposerRun,
    finishProposerRun,
    ingestFindings,
    listProposals,
    markProposerRunRunning,
    parseAnnotation,
    saveAnnotation,
    saveRankScore,
    type ProposalRow,
} from "../db/proposals.js"
import { broadcast } from "../event-broadcaster.js"
import { probeRowDivergence } from "./divergence-probe.js"

export interface ProposerRunnerOptions extends ProposerPassOptions {
  tenantId:    string
  triggeredBy: string
  trigger:     "schedule" | "manual" | "retry"
  /** Inject the LLM port when annotation should run; null/undefined skips it. */
  llm?:        LlmCompletionPort | null
}

export interface ProposerRunnerResult {
  runId:          string
  passResult:     ProposerPassResult
  insertedIds:    readonly string[]
  annotatedCount: number
  rankedCount:    number
}

/**
 * Execute one proposer pass end-to-end: scan → persist → annotate → rank.
 * Caller is responsible for concurrency control across env-pairs (the
 * scheduler enforces "one run per pair at a time").
 */
export async function runProposer(
  host:     AgentHost,
  envPair:  EnvPair,
  options:  ProposerRunnerOptions,
): Promise<ProposerRunnerResult> {
  const runId = createProposerRun({
    tenantId:    options.tenantId,
    source:      envPair.source,
    target:      envPair.target,
    triggeredBy: options.triggeredBy,
    trigger:     options.trigger,
  })
  markProposerRunRunning(runId)
  broadcast({ type: EventType.SyncProposerRunStarted, data: { runId, envPair, triggeredBy: options.triggeredBy } })

  const deps = buildPassDeps(host, options.tenantId)
  let passResult: ProposerPassResult
  try {
    passResult = await runProposerPass(envPair, options, deps)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    finishProposerRun({
      id: runId, status: "failed",
      counts: { scanned: 0, produced: 0, errors: 1 }, durationMs: 0, error: msg,
    })
    broadcast({ type: EventType.SyncProposerRunFailed, data: { runId, error: msg } })
    throw e
  }

  const insertedIds = ingestFindings(options.tenantId, runId, passResult.findings)

  let annotatedCount = 0
  if (options.llm && insertedIds.length > 0) {
    annotatedCount = await annotateInserted(options.tenantId, insertedIds, options.llm)
  }

  const rankedCount = rerankOpenQueue(options.tenantId)

  finishProposerRun({
    id: runId, status: "completed",
    counts: passResult.counts, durationMs: passResult.durationMs, error: null,
  })
  broadcast({
    type: EventType.SyncProposerRunCompleted,
    data: { runId, envPair, counts: passResult.counts, inserted: insertedIds.length, annotated: annotatedCount },
  })

  return { runId, passResult, insertedIds, annotatedCount, rankedCount }
}

// ── DI wiring ────────────────────────────────────────────────────

function buildPassDeps(host: AgentHost, tenantId: string): ProposerPassDeps {
  return {
    now: () => new Date().toISOString(),
    listEntities: async (_envPair) => {
      const defs = listEntityDefinitions(tenantId, { includeRetired: false })
      const descriptors: EntityDescriptor[] = []
      for (const d of defs) {
        const resolved = tryResolveRecipe({ tenantId, entityId: d.id })
        if (!resolved) continue
        descriptors.push({ id: d.id, label: d.displayName ?? d.id, defVersion: d.version })
      }
      return descriptors
    },
    probeCatalogDrift: async (envPair, ent) => {
      const resolved = tryResolveRecipe({ tenantId, entityId: ent.id })
      if (!resolved) return { issues: [] }
      const recipe = resolved.recipe
      const allowedSchemas = uniqueSchemasFromRecipe(recipe.tables.map((t) => t.name))
      try {
        const r = await detectCatalogDrift(host, envPair.source, envPair.target, recipe.tables.map((t) => t.name), allowedSchemas)
        return { issues: r.issues }
      } catch (e) {
        return { issues: [`catalog probe failed: ${e instanceof Error ? e.message : String(e)}`] }
      }
    },
    scanDivergentRows: async (envPair, ent) => {
      return probeRowDivergence({ host, tenantId, envPair, entityId: ent.id, entityLabel: ent.label })
    },
  }
}

function uniqueSchemasFromRecipe(tables: readonly string[]): readonly string[] {
  const set = new Set<string>()
  for (const t of tables) {
    const i = t.indexOf(".")
    if (i > 0) set.add(t.slice(0, i))
  }
  return [...set]
}

// ── annotation + ranking helpers ────────────────────────────────

async function annotateInserted(
  tenantId: string,
  ids:      readonly string[],
  llm:      LlmCompletionPort,
): Promise<number> {
  const rows = listProposals({ tenantId, status: ["open"], limit: 1000 })
  const subset = rows.filter((r) => ids.includes(r.id))
  let n = 0
  for (const r of subset) {
    const finding = rowToFinding(r)
    try {
      const ann = await annotateProposal(finding, {}, llm)
      saveAnnotation(r.id, ann.annotation, ann.failedOpen)
      n++
    } catch (e) {
      // Hard failure: persist a critical "annotator-error" stamp so reviewers see it.
      saveAnnotation(r.id, {
        riskTier: "critical", riskScore: 95,
        rationale: `Annotator threw: ${e instanceof Error ? e.message : String(e)}. Manual review required.`,
        recommendedWindow: "any", dependsOn: [],
        warnings: [{ kind: "unverified-table", message: "Annotator unavailable" }],
      }, true)
    }
  }
  return n
}

function rerankOpenQueue(tenantId: string): number {
  const open = listProposals({
    tenantId,
    status: ["open", "awaiting_approval", "previewed", "snoozed"],
    limit: 5000,
  })
  const rankable: RankableProposal[] = open.map((r) => ({
    id:         r.id,
    finding:    rowToFinding(r),
    annotation: parseAnnotation(r),
    enqueuedAt: r.enqueued_at,
  }))
  const { ranked } = rankProposals(rankable)
  for (const item of ranked) saveRankScore(item.id, item.score)
  return ranked.length
}

function rowToFinding(r: ProposalRow): ProposerFinding {
  return {
    envPair:    { source: r.source, target: r.target },
    entityType: r.entity_type,
    entityId:   r.entity_id,
    entityLabel: r.entity_label,
    kind:       r.kind,
    counts:     r.counts_json ? JSON.parse(r.counts_json) : emptyCounts(),
    detail:     JSON.parse(r.detail_json),
    fingerprint: r.fingerprint,
    entityDefVersion: r.entity_def_version,
    observedAt: r.observed_at,
  }
}
