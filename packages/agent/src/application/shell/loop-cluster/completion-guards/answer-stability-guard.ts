/**
 * Answer-stability completion override (Phase 4 of trace-2026-05-21 plan).
 *
 * Trace symptom: the agent produced a complete, correct final answer at
 * iteration 11, then iterations 12–17 regenerated structurally-identical
 * markdown (same row counts, same section headers, same conclusion) because
 * downstream guards kept asking for more verification / grounding. Each
 * regeneration burned ~2k tokens for zero new information.
 *
 * Fix: when the assistant returns a response with NO tool calls AND the
 * response looks like a real final answer (table + section header + a
 * conclusion sentence) AND its structural signature is identical to the
 * previous no-tool-call response, accept it and stop the loop — short-
 * circuiting downstream guards that would otherwise re-nudge.
 *
 * The signature deliberately ignores prose wording: only row counts,
 * section-header counts, and overall length matter. Two iterations in a
 * row producing the same shape ⇒ the model has converged.
 *
 * Guarded by `enableAnswerStabilityGuard` (default true). If the response
 * has tool calls, this guard never fires (the loop already continues).
 */

import type { CompletionGuardContext } from "./index.js"

/** Stable structural signature of a candidate final answer. */
export interface AnswerSignature {
  readonly tableRowCount: number
  readonly sectionCount: number
  readonly length: number
}

const TABLE_ROW_LINE = /^\s*\|.+\|\s*$/
const TABLE_SEPARATOR_LINE = /^\s*\|?\s*:?-{3,}/
const SECTION_HEADER_LINE = /^\s*#{1,6}\s+\S/
const CONCLUSION_KEYWORDS = /\b(unlock|next step|recommendation|conclusion|summary|takeaway|in summary|key finding)\b/i

/**
 * Compute the structural signature of a candidate final answer.
 * Returns `null` if the answer is too thin to qualify (no table, no header,
 * or no conclusion sentence) — such answers are not eligible for the
 * stability override and must still pass the normal guard chain.
 */
export function computeAnswerSignature(content: string | null): AnswerSignature | null {
  if (!content) return null
  const lines = content.split("\n")
  let tableRowCount = 0
  let sectionCount = 0
  for (const raw of lines) {
    if (TABLE_ROW_LINE.test(raw) && !TABLE_SEPARATOR_LINE.test(raw)) tableRowCount += 1
    if (SECTION_HEADER_LINE.test(raw)) sectionCount += 1
  }
  if (tableRowCount < 1) return null
  if (sectionCount < 1) return null
  if (!CONCLUSION_KEYWORDS.test(content)) return null
  return { tableRowCount, sectionCount, length: content.length }
}

function signaturesEqual(a: AnswerSignature, b: AnswerSignature): boolean {
  return (
    a.tableRowCount === b.tableRowCount
    && a.sectionCount === b.sectionCount
    && a.length === b.length
  )
}

/**
 * Returns `true` if the current response should override downstream guards
 * and be accepted as final. The caller is expected to call this BEFORE the
 * normal guard chain.
 *
 * Records the current signature on `state.lastAnswerSignature` so the next
 * no-tool-call iteration can compare against it.
 */
export function checkAnswerStability(ctx: CompletionGuardContext): boolean {
  const { response, state, config } = ctx
  if (config.enableAnswerStabilityGuard === false) return false
  if (response.toolCalls.length > 0) {
    state.lastAnswerSignature = undefined
    return false
  }
  const sig = computeAnswerSignature(response.content)
  if (!sig) {
    state.lastAnswerSignature = undefined
    return false
  }
  const prev = state.lastAnswerSignature
  state.lastAnswerSignature = sig
  if (!prev) return false
  return signaturesEqual(prev, sig)
}
