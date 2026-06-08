// Per-run clarification state for the orchestrator.
//
// Owns three pieces of state keyed by runId:
//
//   • emittedFindings  — every finding the system-messages renderer has
//                        shown the agent this run. Used to match an
//                        incoming ask_user question against a known
//                        finding so we can record the answer as a
//                        ResolvedClarification.
//
//   • pendingMatch     — the most recent finding the agent's ask_user
//                        call matched against. Resolved by
//                        respondToRun(runId, answer).
//
//   • resolved         — answered clarifications, surfaced via
//                        getResolved(runId) and used by the next
//                        round's detector context to suppress re-asking.
//
// Pure state machine — no I/O, no LLM. The matching helper uses a
// simple normalised-string-overlap score; we are not doing NLP, just
// "does this question text look enough like a question we recently
// asked?".

import type { AmbiguityFinding, ResolvedClarification } from "@mia/agent"
import type { ClarificationMatch, ClarificationsRegistryPort } from "../../../ports/clarifications.js"

type EmittedRecord = ClarificationMatch

interface PendingRecord extends EmittedRecord {
  readonly askedQuestion: string
}

export class ClarificationsRegistry implements ClarificationsRegistryPort {
  private readonly emitted = new Map<string, EmittedRecord[]>()
  private readonly pending = new Map<string, PendingRecord>()
  private readonly resolvedByRun = new Map<string, ResolvedClarification[]>()

  /** Replace the run's emitted list with the latest set rendered this round. */
  recordEmitted(runId: string, round: number, findings: readonly AmbiguityFinding[]): void {
    if (findings.length === 0) {
      // Keep the prior list — we may have emitted in an earlier round and
      // the user might still be answering that. Don't clobber on a quiet round.
      return
    }
    const cur = this.emitted.get(runId) ?? []
    // Merge: keep prior records but overlay any same-id record with the
    // most recent round number / question text.
    const byId = new Map(cur.map((r) => [r.findingId, r]))
    for (const f of findings) {
      byId.set(f.id, {
        findingId: f.id,
        kind: f.kind,
        subject: f.subject,
        suggestedQuestion: f.suggestedQuestion,
        uiOptions: f.uiOptions,
        round
      })
    }
    this.emitted.set(runId, [...byId.values()])
  }

  /**
   * Find the emitted finding (if any) whose suggestedQuestion best matches
   * the question the agent just passed to ask_user. Match is computed as a
   * token-overlap ratio over a normalised tokenisation; threshold is
   * deliberately permissive (0.4) because the agent often rephrases.
   * Returns null when no record exists or no candidate clears the bar.
   */
  matchQuestion(runId: string, question: string): EmittedRecord | null {
    const records = this.emitted.get(runId)
    if (!records || records.length === 0) return null
    const qTokens = tokenise(question)
    if (qTokens.size === 0) return null
    let best: { rec: EmittedRecord; score: number } | null = null
    for (const rec of records) {
      const score = overlapScore(qTokens, tokenise(rec.suggestedQuestion))
      if (score > (best?.score ?? 0)) best = { rec, score }
    }
    if (!best || best.score < 0.5) return null
    return best.rec
  }

  /**
   * Stash a (finding, asked-question) pair as pending — the orchestrator
   * calls this when ask_user fires AND matchQuestion returned a hit.
   */
  setPending(runId: string, record: EmittedRecord, askedQuestion: string): void {
    this.pending.set(runId, { ...record, askedQuestion })
  }

  /**
   * Resolve the pending clarification (if any) for this run with the
   * user's answer. Returns the new ResolvedClarification on success or
   * null when nothing was pending. The pending entry is cleared either way.
   */
  resolvePending(runId: string, answer: string, atRound: number): ResolvedClarification | null {
    const pending = this.pending.get(runId)
    if (!pending) return null
    this.pending.delete(runId)
    const resolved: ResolvedClarification = {
      findingId: pending.findingId,
      kind: pending.kind,
      subject: pending.subject,
      question: pending.askedQuestion,
      answer,
      resolvedAtRound: atRound
    }
    const list = this.resolvedByRun.get(runId) ?? []
    list.push(resolved)
    this.resolvedByRun.set(runId, list)
    return resolved
  }

  /** All resolved clarifications for the run, in resolution order. */
  getResolved(runId: string): ResolvedClarification[] {
    return [...(this.resolvedByRun.get(runId) ?? [])]
  }

  /** Drop all per-run state. Called on run completion / cleanup. */
  clear(runId: string): void {
    this.emitted.delete(runId)
    this.pending.delete(runId)
    this.resolvedByRun.delete(runId)
  }
}

// ── Matching helpers ─────────────────────────────────────────────

const MATCH_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "in",
  "on",
  "to",
  "for",
  "with",
  "by",
  "as",
  "is",
  "are",
  "was",
  "were",
  "what",
  "which",
  "who",
  "when",
  "where",
  "why",
  "how",
  "do",
  "does",
  "did",
  "you",
  "your",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "it",
  "this",
  "that",
  "did",
  "mean",
  "meant",
  "could",
  "would",
  "should",
  "can",
  "please"
])

function tokenise(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 3) continue
    if (MATCH_STOPWORDS.has(t)) continue
    out.add(t)
  }
  return out
}

/**
 * Overlap coefficient (Szymkiewicz–Simpson) — |A ∩ B| / min(|A|, |B|).
 * Picked over Jaccard because the agent often expands a short
 * suggested question with extra context tokens ("voluntary,
 * involuntary, or both?") — Jaccard penalises that expansion while
 * overlap rewards "are the small set's tokens contained in the larger".
 * Returns 0 when either set is empty.
 */
function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const denom = Math.min(a.size, b.size)
  return denom === 0 ? 0 : inter / denom
}
