import type { AmbiguityFinding, ResolvedClarification } from "@mia/agent"

export interface ClarificationsPort {
  recordEmitted(runId: string, round: number, findings: readonly AmbiguityFinding[]): void
  getResolved(runId: string): ResolvedClarification[]
}

export interface ClarificationMatch {
  readonly findingId: string
  readonly kind: AmbiguityFinding["kind"]
  readonly severity: AmbiguityFinding["severity"]
  readonly subject: string
  readonly suggestedQuestion: string
  readonly uiOptions?: readonly string[]
  readonly round: number
}

export interface ClarificationsRegistryPort extends ClarificationsPort {
  getFinding(runId: string, findingId: string): ClarificationMatch | null
  getOpenBlocking(runId: string): ClarificationMatch[]
  matchQuestion(runId: string, question: string): ClarificationMatch | null
  isResolved(runId: string, findingId: string): boolean
  setPending(runId: string, record: ClarificationMatch, askedQuestion: string): void
  resolvePending(runId: string, answer: string, atRound: number): ResolvedClarification | null
  clear(runId: string): void
}
