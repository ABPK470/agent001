import type { AmbiguityFinding, ResolvedClarification } from "@mia/agent"

export interface ClarificationsPort {
  recordEmitted(runId: string, round: number, findings: readonly AmbiguityFinding[]): void
  getResolved(runId: string): ResolvedClarification[]
}

export interface ClarificationMatch {
  readonly findingId: string
  readonly kind: AmbiguityFinding["kind"]
  readonly subject: string
  readonly suggestedQuestion: string
  readonly uiOptions?: readonly string[]
  readonly round: number
}

export interface ClarificationsRegistryPort extends ClarificationsPort {
  matchQuestion(runId: string, question: string): ClarificationMatch | null
  setPending(runId: string, record: ClarificationMatch, askedQuestion: string): void
  resolvePending(runId: string, answer: string, atRound: number): ResolvedClarification | null
  clear(runId: string): void
}