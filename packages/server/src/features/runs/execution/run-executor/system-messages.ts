import { getCatalog, PolicyRole, type AgentHost, type Tool } from "@mia/agent"
import { broadcastTrace } from "../../../../platform/events/broadcaster.js"
import { TrajectoryEventKind } from "../../../../shared/enums/trajectory.js"
import { loadCandidateVerdicts, loadKnownObjects } from "../../core/data-blocks/known-objects.js"
import { loadPriorResults } from "../../core/data-blocks/prior-results-block.js"
import { loadPriorTurns } from "../../core/data-blocks/prior-turns.js"
import { buildSystemMessages } from "../../core/system-messages.js"
import type {
  ActiveRunRecord,
  ExecuteRunInput,
  ExecutionSystemMessagesBundle,
  RunWorkspace
} from "./types.js"

export async function buildExecutionSystemMessages(
  input: ExecuteRunInput,
  envBase: {
    activeRun: ActiveRunRecord | undefined
    runWorkspace: RunWorkspace
    perRunHost: AgentHost
    allTools: Tool[]
    boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void
    debugSeqRef: { value: number }
  },
  perTier: { working: string; episodic: string; semantic: string }
): Promise<ExecutionSystemMessagesBundle> {
  const priorTurns =
    envBase.activeRun?.sessionId &&
    envBase.activeRun?.ownerUpn &&
    envBase.runWorkspace.taskType !== "code_generation"
      ? loadPriorTurns({
          sessionId: envBase.activeRun.sessionId,
          excludeRunId: input.runId,
          upn: envBase.activeRun.ownerUpn,
          limit: 3
        })
      : []

  const priorResults =
    envBase.activeRun?.sessionId && envBase.runWorkspace.taskType !== "code_generation"
      ? loadPriorResults({ sessionId: envBase.activeRun.sessionId, excludeRunId: input.runId })
      : []

  const systemMessages = await buildSystemMessages({
    goal: input.goal,
    systemPrompt: input.systemPrompt,
    allTools: envBase.allTools,
    runWorkspace: envBase.runWorkspace,
    perTier,
    runId: input.runId,
    host: envBase.perRunHost,
    attachmentIds: envBase.activeRun?.attachmentIds ?? [],
    priorTurns,
    priorResults,
    knownObjects: (() => {
      try {
        return loadKnownObjects({ goal: input.goal, priorTurns })
      } catch (error) {
        console.warn(`[run ${input.runId}] knownObjects load failed:`, (error as Error).message)
        return []
      }
    })(),
    knownVerdicts: (() => {
      try {
        return loadCandidateVerdicts({
          goal: input.goal,
          catalog: getCatalog(envBase.perRunHost),
          upn: envBase.activeRun?.ownerUpn ?? null
        })
      } catch (error) {
        console.warn(`[run ${input.runId}] knownVerdicts load failed:`, (error as Error).message)
        return []
      }
    })(),
    clarifications: input.ctx.clarifications,
    llmForClarification: input.ctx.llm,
    onClarificationTrace: (event) => {
      if (event.kind === "detected") {
        envBase.boundSaveTrace(input.runId, {
          kind: TrajectoryEventKind.ClarificationDetected,
          findingId: event.finding.id,
          ambiguityKind: event.finding.kind,
          severity: event.finding.severity,
          subject: event.finding.subject,
          source: event.finding.source,
          suggestedQuestion: event.finding.suggestedQuestion
        } as Record<string, unknown>)
      } else {
        envBase.boundSaveTrace(input.runId, {
          kind: TrajectoryEventKind.ClarificationLlmPlannerInvoked,
          findingsCount: event.findingsCount
        } as Record<string, unknown>)
      }
    },
    isAdmin: (envBase.activeRun?.role ?? PolicyRole.HostedUser) === PolicyRole.Admin,
    hasSiblings: !!input.resume?.parentRunId || input.bus.history().length > 0,
    siblingProgressDigest: (() => {
      const recent = input.bus.history().slice(-6)
      if (recent.length === 0) return ""
      return recent
        .map((message) => {
          const line = `- [${message.fromAgent}] (${message.protocol}, ${message.topic}): ${message.content}`
          return line.length > 240 ? line.slice(0, 237) + "..." : line
        })
        .join("\n")
    })(),
    coordinationTopic: `${input.runId}-status`
  })

  const effectivePrompt = systemMessages.map((message) => message.content).join("\n\n")
  envBase.boundSaveTrace(input.runId, {
    kind: TrajectoryEventKind.SystemPrompt,
    text: effectivePrompt || "(no system prompt)"
  })
  broadcastTrace(input.runId, envBase.debugSeqRef.value++, {
    kind: TrajectoryEventKind.SystemPrompt,
    text: effectivePrompt || "(no system prompt)"
  })
  const toolsResolvedEntry = {
    kind: TrajectoryEventKind.ToolsResolved,
    tools: envBase.allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  }
  envBase.boundSaveTrace(input.runId, toolsResolvedEntry)
  broadcastTrace(input.runId, envBase.debugSeqRef.value++, toolsResolvedEntry)
  return { effectivePrompt, systemMessages }
}
