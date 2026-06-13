import { getCatalog, PolicyRole, type AgentHost, type Tool } from "@mia/agent"
import { broadcastTrace } from "../../../../platform/events/broadcaster.js"
import { TrajectoryEventKind } from "../../../../shared/enums/trajectory.js"
import { loadCandidateVerdicts, loadKnownObjects } from "../../core/data-blocks/known-objects.js"
import { loadPriorResults } from "../../core/data-blocks/prior-results-block.js"
import { loadPriorTurns } from "../../core/data-blocks/prior-turns.js"
import { buildSystemMessages } from "../../core/system-messages/index.js"
import type {
  ActiveRunRecord,
  ExecuteRunRequestDto,
  ExecutionSystemMessagesBundle,
  RunInteractionPort,
  RunMessagingPort,
  RunWorkspace
} from "./types.js"

export async function buildExecutionSystemMessages(
  input: {
    request: ExecuteRunRequestDto
    interaction: RunInteractionPort
    messaging: RunMessagingPort
  },
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
  const { request, interaction, messaging } = input
  const priorTurns =
    envBase.activeRun?.ownerUpn &&
    envBase.activeRun.threadId &&
    envBase.runWorkspace.taskType !== "code_generation"
      ? loadPriorTurns({
          threadId: envBase.activeRun.threadId,
          excludeRunId: request.runId,
          upn: envBase.activeRun.ownerUpn,
          limit: 3
        })
      : []

  const priorResults =
    envBase.activeRun?.threadId &&
    envBase.activeRun.ownerUpn &&
    envBase.runWorkspace.taskType !== "code_generation"
      ? loadPriorResults({
          threadId: envBase.activeRun.threadId,
          upn: envBase.activeRun.ownerUpn,
          excludeRunId: request.runId
        })
      : []

  const systemMessages = await buildSystemMessages({
    goal: request.goal,
    systemPrompt: request.systemPrompt,
    allTools: envBase.allTools,
    runWorkspace: envBase.runWorkspace,
    perTier,
    runId: request.runId,
    host: envBase.perRunHost,
    attachmentIds: envBase.activeRun?.attachmentIds ?? [],
    priorTurns,
    priorResults,
    knownObjects: (() => {
      try {
        return loadKnownObjects({ goal: request.goal, priorTurns })
      } catch (error) {
        console.warn(`[run ${request.runId}] knownObjects load failed:`, (error as Error).message)
        return []
      }
    })(),
    knownVerdicts: (() => {
      try {
        return loadCandidateVerdicts({
          goal: request.goal,
          catalog: getCatalog(envBase.perRunHost),
          upn: envBase.activeRun?.ownerUpn ?? null
        })
      } catch (error) {
        console.warn(`[run ${request.runId}] knownVerdicts load failed:`, (error as Error).message)
        return []
      }
    })(),
    clarifications: interaction.clarifications,
    llmForClarification: interaction.llm,
    onClarificationTrace: (event) => {
      if (event.kind === "detected") {
        envBase.boundSaveTrace(request.runId, {
          kind: TrajectoryEventKind.ClarificationDetected,
          findingId: event.finding.id,
          ambiguityKind: event.finding.kind,
          severity: event.finding.severity,
          subject: event.finding.subject,
          source: event.finding.source,
          suggestedQuestion: event.finding.suggestedQuestion
        } as Record<string, unknown>)
      } else {
        envBase.boundSaveTrace(request.runId, {
          kind: TrajectoryEventKind.ClarificationLlmPlannerInvoked,
          findingsCount: event.findingsCount
        } as Record<string, unknown>)
      }
    },
    isAdmin: (envBase.activeRun?.role ?? PolicyRole.HostedUser) === PolicyRole.Admin,
    hasSiblings: !!request.resume?.parentRunId || messaging.history().length > 0,
    siblingProgressDigest: (() => {
      const recent = messaging.history().slice(-6)
      if (recent.length === 0) return ""
      return recent
        .map((message) => {
          const line = `- [${message.fromAgent}] (${message.protocol}, ${message.topic}): ${message.content}`
          return line.length > 240 ? line.slice(0, 237) + "..." : line
        })
        .join("\n")
    })(),
    coordinationTopic: `${request.runId}-status`
  })

  const effectivePrompt = systemMessages.map((message) => message.content).join("\n\n")
  envBase.boundSaveTrace(request.runId, {
    kind: TrajectoryEventKind.SystemPrompt,
    text: effectivePrompt || "(no system prompt)"
  })
  broadcastTrace(request.runId, envBase.debugSeqRef.value++, {
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
  envBase.boundSaveTrace(request.runId, toolsResolvedEntry)
  broadcastTrace(request.runId, envBase.debugSeqRef.value++, toolsResolvedEntry)
  return { effectivePrompt, systemMessages }
}
