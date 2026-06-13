import type { LLMClient, Tool } from "@mia/agent"
import type { DbToolResult } from "../../../../platform/persistence/sqlite.js"
import type { ClarificationsPort } from "../../../../ports/clarifications.js"
import type { RunWorkspaceContext } from "../../workspace/index.js"
import type { CandidateVerdictRow, KnownObjectRow } from "../data-blocks/known-objects.js"
import type { PriorTurn } from "../data-blocks/prior-turns.js"
import type { SectionDecision } from "../decide-sections.js"

export interface BuildSystemMessagesOptions {
  goal: string
  systemPrompt: string | undefined
  allTools: Tool[]
  runWorkspace: RunWorkspaceContext
  perTier: { working: string; episodic: string; semantic: string }
  runId: string
  host?: import("@mia/agent").AgentHost
  attachmentIds?: string[]
  hasSiblings?: boolean
  siblingProgressDigest?: string
  coordinationTopic?: string
  clarifications?: ClarificationsPort
  llmForClarification?: LLMClient
  onClarificationTrace?: (
    event:
      | { kind: "detected"; finding: import("@mia/agent").AmbiguityFinding }
      | { kind: "planner-invoked"; findingsCount: number }
  ) => void
  isAdmin?: boolean
  priorTurns?: readonly PriorTurn[]
  knownObjects?: readonly KnownObjectRow[]
  knownVerdicts?: readonly CandidateVerdictRow[]
  priorResults?: readonly DbToolResult[]
}

export interface BuildContext {
  readonly opts: BuildSystemMessagesOptions
  readonly runId: string
  readonly goal: string
  readonly isAdmin: boolean
  readonly hasSiblings: boolean
  readonly siblingProgressDigest: string
  readonly coordinationTopic: string
  readonly priorTurns: readonly PriorTurn[]
  readonly knownObjects: readonly KnownObjectRow[]
  readonly knownVerdicts: readonly CandidateVerdictRow[]
  readonly priorResults: readonly DbToolResult[]
  readonly decision: SectionDecision
  readonly syncOperationIntent: ReturnType<
    typeof import("@mia/sync").parseSyncOperationIntentForHost
  > | null
}
