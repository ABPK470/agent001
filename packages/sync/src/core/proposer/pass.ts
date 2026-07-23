/**
 * F1.1 — Deterministic proposer pass.
 *
 * Given an env-pair and a set of entities (resolved through the registry),
 * produces a flat list of `ProposerFinding` rows. This module is *pure
 * orchestration*: it stays free of any DB / network IO by delegating
 * every external probe through the `ProposerPassDeps` DI seam.
 *
 * The server side (packages/server/src/proposer/runner.ts) wires the
 * concrete adapters that talk to MSSQL, the entity registry, and the
 * existing diff-engine helpers.
 */
import { asEntityId, type EntityId } from "../../domain/types/branded-ids.js"


import { canonicalSha256 } from "./canonical.js"
import {
  emptyCounts,
  formatEnvPair,
  ProposalKind,
  type EnvPair,
  type ProposalCounts,
  type ProposerFinding,
  type ProposerFindingDetail,
  type ProposerRunCounts
} from "./types.js"

// ── DI seam ──────────────────────────────────────────────────────

export interface EntityDescriptor {
  /** Stable machine id (registry entity id). */
  id: string
  /** Display label used in the UI when surfacing the finding. */
  label: string
  /** Snapshot of the registry version that produced this descriptor. */
  defVersion: number | null
}

export interface CatalogDriftProbe {
  /** Plain-text issues (matches existing `detectCatalogDrift` output). */
  issues: readonly string[]
}

export interface DivergentEntityRow {
  entityId: EntityId
  entityLabel: string
  counts: ProposalCounts
  /** Per-table breakdown — empty for "new entity" findings. */
  perTable: ReadonlyArray<{ name: string; counts: ProposalCounts }>
  /** True iff the entity row is absent on target (drives ProposalKind.New). */
  newOnTarget: boolean
}

export interface ProposerPassDeps {
  /** Enumerate the entities to scan for an env-pair. */
  listEntities: (envPair: EnvPair) => Promise<readonly EntityDescriptor[]>
  /** Cheap catalog probe; should be safe to call concurrently. */
  probeCatalogDrift: (envPair: EnvPair, entity: EntityDescriptor) => Promise<CatalogDriftProbe>
  /** Discover divergent rows; if catalog drift is present the runner
      typically skips this (drift dominates and would corrupt the diff). */
  scanDivergentRows: (envPair: EnvPair, entity: EntityDescriptor) => Promise<readonly DivergentEntityRow[]>
  /** ISO timestamp generator — injectable for deterministic tests. */
  now: () => string
}

export interface ProposerPassOptions {
  /** Optional whitelist; when present only these entities are scanned. */
  entityIds?: readonly string[]
  /** Max divergent entities to surface per entity-type per pass. */
  perEntityCap?: number
  /** Per-entity concurrency for `scanDivergentRows`. */
  scanConcurrency?: number
  /** Cap on total findings returned by one pass (DoS guard). */
  maxFindings?: number
  /** When aborted, the pass stops between entities and throws. */
  signal?: AbortSignal
}

export interface ProposerPassResult {
  envPair: EnvPair
  findings: readonly ProposerFinding[]
  counts: ProposerRunCounts
  durationMs: number
}

const DEFAULT_OPTIONS = {
  perEntityCap: 250,
  scanConcurrency: 4,
  maxFindings: 1000
} as const

// ── Pass ─────────────────────────────────────────────────────────

export async function runProposerPass(
  envPair: EnvPair,
  opts: ProposerPassOptions,
  deps: ProposerPassDeps
): Promise<ProposerPassResult> {
  const t0 = Date.now()
  const cap = opts.perEntityCap ?? DEFAULT_OPTIONS.perEntityCap
  // `scanConcurrency` is plumbed through for future parallel row scans; the
  // current MVP scans one entity-type at a time, so the option is accepted
  // but not yet wired into `scanDivergentRows`.
  void (opts.scanConcurrency ?? DEFAULT_OPTIONS.scanConcurrency)
  const maxFindings = opts.maxFindings ?? DEFAULT_OPTIONS.maxFindings

  const allEntities = await deps.listEntities(envPair)
  const scoped = opts.entityIds ? allEntities.filter((e) => opts.entityIds!.includes(e.id)) : allEntities

  const findings: ProposerFinding[] = []
  let scanned = 0
  let errors = 0

  // Per-entity-type scan is sequential at the entity-type level (so a slow
  // one doesn't drown a fast one), but uses `concurrency` for the rows.
  for (const ent of scoped) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Scan cancelled")
    }
    if (findings.length >= maxFindings) break
    scanned++
    try {
      const drift = await deps.probeCatalogDrift(envPair, ent)
      if (drift.issues.length > 0) {
        // Drift dominates: produce ONE drift finding for the entity-type itself
        // (entityId = "*" sentinel) so the operator can fix schema before we
        // try to diff data. Row-level scan is skipped.
        findings.push(
          makeFinding({
            envPair,
            ent,
            entityId: asEntityId("*"),
            entityLabel: ent.label,
            kind: ProposalKind.Drift,
            counts: emptyCounts(),
            detail: { kind: "drift", drift: { issues: drift.issues } },
            observedAt: deps.now()
          })
        )
        continue
      }

      const rows = await deps.scanDivergentRows(envPair, ent)
      const capped = rows.slice(0, cap)
      for (const r of capped) {
        if (findings.length >= maxFindings) break
        const kind = r.newOnTarget ? ProposalKind.New : ProposalKind.OutOfSync
        const detail: ProposerFindingDetail = r.newOnTarget
          ? { kind: "new", newEntities: { sampleIds: [r.entityId] } }
          : { kind: "out_of_sync", outOfSync: { perTable: r.perTable } }
        findings.push(
          makeFinding({
            envPair,
            ent,
            entityId: asEntityId(r.entityId),
            entityLabel: r.entityLabel,
            kind,
            counts: r.counts,
            detail,
            observedAt: deps.now()
          })
        )
      }
    } catch {
      errors++
    }
  }

  return {
    envPair,
    findings,
    counts: { scanned, produced: findings.length, errors },
    durationMs: Date.now() - t0
  }
}

// ── Finding construction (deterministic fingerprint) ─────────────

interface MakeFindingInput {
  envPair: EnvPair
  ent: EntityDescriptor
  entityId: EntityId
  entityLabel: string
  kind: ProposerFinding["kind"]
  counts: ProposalCounts
  detail: ProposerFindingDetail
  observedAt: string
}

function makeFinding(i: MakeFindingInput): ProposerFinding {
  // Fingerprint = canonical hash over the *semantic* identity of the
  // finding, intentionally excluding observedAt so a re-run of the same
  // finding hashes the same and can be deduped against open proposals.
  const fingerprint = canonicalSha256({
    envPair: formatEnvPair(i.envPair),
    entityType: i.ent.id,
    entityId: i.entityId,
    kind: i.kind,
    detail: i.detail
  })
  return {
    envPair: i.envPair,
    entityType: i.ent.id,
    entityId: i.entityId,
    entityLabel: i.entityLabel,
    kind: i.kind,
    counts: i.counts,
    detail: i.detail,
    fingerprint,
    entityDefVersion: i.ent.defVersion,
    observedAt: i.observedAt
  }
}
