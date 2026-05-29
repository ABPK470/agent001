// Renders the <must_clarify> + <resolved_clarifications> system block
// from a list of AmbiguityFindings and ResolvedClarifications.
//
// Block format is XML-tagged so the agent (and our tests) can grep for
// it and so it survives prompt truncation as a single section. The
// content inside is plain prose that the LLM reads as authoritative
// guidance — "before answering, resolve these".
//
// Empty-input contract: returns "" so the caller can skip emitting
// the section entirely. Never throws.

import type { AmbiguityFinding, ResolvedClarification } from "@mia/agent"
import { CLARIFY_BLOCK_BUDGET_BYTES, blockingFindings } from "@mia/agent"

export interface ClarificationBlockInput {
  readonly findings: readonly AmbiguityFinding[]
  readonly resolved: readonly ResolvedClarification[]
}

/**
 * Format a single finding as a one-line bullet. Severity prefix lets
 * the agent prioritise visually: 🛑 = block (must ask), ⚠ = warn (consider asking).
 */
function renderFinding(f: AmbiguityFinding): string {
  const sev = f.severity === "block" ? "🛑" : "⚠"
  const candidates = f.candidates && f.candidates.length > 0
    ? `  candidates: ${f.candidates.slice(0, 6).join(", ")}\n`
    : ""
  const uiOptions = f.uiOptions && f.uiOptions.length > 0
    ? `  ui options: ${f.uiOptions.slice(0, 6).join(", ")}\n`
    : ""
  return [
    `${sev} [${f.kind}] subject="${f.subject}" (source: ${f.source})`,
    `  reasoning: ${f.reasoning}`,
    candidates,
    uiOptions,
    `  suggested question: ${f.suggestedQuestion}`,
  ].join("\n").replace(/\n+$/g, "")
}

function renderResolved(r: ResolvedClarification): string {
  return `• [${r.kind}] subject="${r.subject}" → answer: ${r.answer}`
}

/**
 * Build the system block. Returns "" when there is nothing to say
 * (no findings AND no resolved). Truncates if total length exceeds
 * CLARIFY_BLOCK_BUDGET_BYTES — blocking findings are preserved first.
 */
export function buildClarificationBlock(input: ClarificationBlockInput): string {
  const { findings, resolved } = input
  if (findings.length === 0 && resolved.length === 0) return ""

  const blocks: string[] = []

  if (findings.length > 0) {
    const blocked = blockingFindings(findings)
    const warned = findings.filter((f) => f.severity === "warn")
    const orderedFindings = [...blocked, ...warned]
    const bullets = orderedFindings.map(renderFinding).join("\n\n")
    blocks.push(
      "<must_clarify>",
      "Before answering, you have ambiguities to resolve. Each finding below",
      "is either a 🛑 BLOCK (you MUST ask the user via the ask_user tool",
      "before proceeding) or a ⚠ WARN (call ask_user when you cannot",
      "confidently disambiguate from context). One ask_user call per finding;",
      "use the suggested question or a clearer phrasing — do NOT batch all",
      "questions into a single call. `candidates` are reasoning context only;",
      "do NOT copy them into ask_user options unless explicit `ui options` are present.",
      "",
      bullets,
      "</must_clarify>",
    )
  }

  if (resolved.length > 0) {
    blocks.push(
      "<resolved_clarifications>",
      "The user has already answered the following clarifications this run.",
      "Treat their answers as authoritative; do NOT re-ask the same subject.",
      "",
      resolved.map(renderResolved).join("\n"),
      "</resolved_clarifications>",
    )
  }

  const joined = blocks.join("\n")
  if (joined.length <= CLARIFY_BLOCK_BUDGET_BYTES) return joined

  // Over budget — keep blocking findings + resolved; drop warns.
  if (findings.length > 0) {
    const blocked = blockingFindings(findings)
    const truncated = buildClarificationBlock({ findings: blocked, resolved })
    return truncated
  }
  // Resolved alone — truncate tail.
  return `${joined.slice(0, CLARIFY_BLOCK_BUDGET_BYTES - 32)}\n…truncated…`
}
