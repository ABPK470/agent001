import type { ClarificationMatch } from "../../../ports/clarifications.js"

/**
 * Clarification findings own the authoritative pick-list contract.
 * When ask_user matches a known finding, ignore model-supplied options:
 * use the finding's uiOptions when present, otherwise force free-text.
 */
export function enforceClarificationUiOptions(
  options: string[] | undefined,
  match: ClarificationMatch | null
): string[] | undefined {
  if (!match) return options
  if (!match.uiOptions || match.uiOptions.length === 0) return undefined
  return [...match.uiOptions]
}
