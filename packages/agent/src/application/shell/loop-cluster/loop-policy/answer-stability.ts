/**
 * Answer-stability completion override.
 *
 * When the model returns two consecutive no-tool-call responses with the
 * same structural signature (table rows, section headers, length), accept
 * the answer and bypass downstream completion rules.
 */

import type { LoopPolicyContext } from "./types.js"

export interface AnswerSignature {
  readonly tableRowCount: number
  readonly sectionCount: number
  readonly length: number
}

const TABLE_ROW_LINE = /^\s*\|.+\|\s*$/
const TABLE_SEPARATOR_LINE = /^\s*\|?\s*:?-{3,}/
const SECTION_HEADER_LINE = /^\s*#{1,6}\s+\S/
const CONCLUSION_KEYWORDS =
  /\b(unlock|next step|recommendation|conclusion|summary|takeaway|in summary|key finding)\b/i

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
  return a.tableRowCount === b.tableRowCount && a.sectionCount === b.sectionCount && a.length === b.length
}

/** True when the model has converged — caller should allow completion. */
export function checkAnswerStability(ctx: LoopPolicyContext): boolean {
  const response = ctx.response
  const config = ctx.config
  if (!response || !config) return false
  if (config.enableAnswerStabilityGuard === false) return false
  if (response.toolCalls.length > 0) {
    ctx.state.lastAnswerSignature = undefined
    return false
  }
  const sig = computeAnswerSignature(response.content)
  if (!sig) {
    ctx.state.lastAnswerSignature = undefined
    return false
  }
  const prev = ctx.state.lastAnswerSignature
  ctx.state.lastAnswerSignature = sig
  if (!prev) return false
  return signaturesEqual(prev, sig)
}
