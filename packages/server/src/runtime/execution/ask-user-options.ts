import type { ClarificationMatch } from "../../../ports/clarifications.js"

/**
 * Clarification findings own the authoritative pick-list contract.
 * When ask_user matches a known finding:
 *   - use `uiOptions` when the finding declared a closed set
 *   - otherwise force free-text (model must not copy `candidates` into options)
 */
export function enforceClarificationUiOptions(
  options: string[] | undefined,
  match: ClarificationMatch | null
): string[] | undefined {
  if (!match) return options?.length ? options : undefined
  if (match.uiOptions && match.uiOptions.length > 0) return [...match.uiOptions]
  return undefined
}

/** First line only — bullets belong in must_clarify for the agent, not the user card. */
export function compactAskUserQuestion(question: string): string {
  const first = question.split(/\n/)[0]?.trim()
  return first && first.length > 0 ? first : question.trim()
}

function normalizeAskUserOptions(options: string[] | undefined): string[] | undefined {
  if (!options?.length) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of options) {
    const option = raw.trim()
    if (!option || seen.has(option)) continue
    seen.add(option)
    out.push(option)
  }
  return out.length > 0 ? out : undefined
}

export function resolveAskUserPresentation(
  question: string,
  options: string[] | undefined,
  match: ClarificationMatch | null
): { question: string; options: string[] | undefined } {
  const effectiveOptions = enforceClarificationUiOptions(options, match)
  const questionText = match
    ? compactAskUserQuestion(match.suggestedQuestion || question)
    : compactAskUserQuestion(question)
  return {
    question: questionText,
    options: normalizeAskUserOptions(effectiveOptions)
  }
}
