import { createRun, PolicyRole, runStarted, startRunningPure, type RunState } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { prepareRunWorkspace } from "../../../../bootstrap/workspace.js"
import { wireEventBroadcasting } from "../../core/coordination/event-wiring.js"
import { createNotification, persistRun, saveTrace } from "../persistence.js"
import type {
  DelegateToolsBundle,
  ExecuteRunInput,
  ExecutionEnvironment,
  ExecutionStateBundle,
  ExecutionSystemMessagesBundle,
  PerRunHostBundle,
  ProgressState,
  RunPersistenceBundle,
  RunWorkspace,
  ToolResolution,
  WorkspacePreparation
} from "./types.js"

export async function prepareWorkspace(input: ExecuteRunInput): Promise<WorkspacePreparation> {
  const baseWorkspace = input.ctx.workspace ?? process.cwd()
  const preActiveRun = input.ctx.activeRuns.get(input.runId)

  const runWorkspace = await prepareRunWorkspace({
    runId: input.runId,
    sourceRoot: baseWorkspace,
    goal: input.goal,
    resume: !!input.resume,
    role: preActiveRun?.role ?? PolicyRole.Admin
  })

  const activeRun = input.ctx.activeRuns.get(input.runId)
  if (activeRun) activeRun.workspace = runWorkspace
  return { activeRun, runWorkspace }
}

export function createExecutionState(input: ExecuteRunInput): ExecutionStateBundle {
  const actor = "user"
  const progress: ProgressState = { lastMessages: [], lastIteration: 0, prevTotalTokens: 0 }
  const state: RunState = {
    run: createRun("agent-session", { goal: input.goal }, input.runId),
    actor,
    stepCounter: input.resume?.iteration ?? 0
  }

  return { actor, progress, state }
}

export function createRunPersistence(
  input: ExecuteRunInput,
  state: RunState,
  actor: string,
  runWorkspace: RunWorkspace
): RunPersistenceBundle {
  const boundSaveTrace = (runId: string, entry: Record<string, unknown>) =>
    saveTrace(input.ctx.activeRuns, runId, entry)

  const persistCurrentRun = (answer?: string, error?: string): void => {
    persistRun(state.run, input.goal, input.agentId, input.resume?.parentRunId, answer, error)
  }

  const saveCurrentRun = async (): Promise<void> => {
    await input.services.runRepo.save(state.run)
  }

  const markRunStarted = async (): Promise<void> => {
    if (state.run.status !== RunStatus.Pending) return
    state.run = startRunningPure(state.run, state.run.steps)
    await saveCurrentRun()
    persistCurrentRun()
    await input.services.eventBus.publish(runStarted(state.run.id, "agent-session"))
  }

  const initialize = async (): Promise<void> => {
    await saveCurrentRun()
    await input.services.auditService.log({
      actor,
      action: "agent.started",
      resourceType: "AgentRun",
      resourceId: state.run.id,
      detail: {
        goal: input.goal,
        tools: input.tools.map((tool) => tool.name),
        agentId: input.agentId,
        profile: runWorkspace.profile,
        workspaceMode: runWorkspace.isolated ? "isolated" : "shared",
        workspaceRoot: runWorkspace.executionRoot
      }
    })
    persistCurrentRun()
  }

  return {
    boundSaveTrace,
    persistCurrentRun,
    markRunStarted,
    initialize
  }
}

export function wireExecutionEvents(
  input: ExecuteRunInput,
  state: RunState,
  boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void
) {
  return wireEventBroadcasting(input.services, input.runId, state, boundSaveTrace, createNotification)
}

export function assembleExecutionEnvironment(input: {
  workspace: WorkspacePreparation
  state: ExecutionStateBundle
  persistence: RunPersistenceBundle
  eventWiring: ReturnType<typeof wireExecutionEvents>
  host: PerRunHostBundle
  tools: ToolResolution
  delegateCtx: DelegateToolsBundle
  systemMessages: ExecutionSystemMessagesBundle
}): ExecutionEnvironment {
  return {
    actor: input.state.actor,
    activeRun: input.workspace.activeRun,
    runWorkspace: input.workspace.runWorkspace,
    state: input.state.state,
    progress: input.state.progress,
    debugSeqRef: input.host.debugSeqRef,
    boundSaveTrace: input.persistence.boundSaveTrace,
    persistCurrentRun: input.persistence.persistCurrentRun,
    markRunStarted: input.persistence.markRunStarted,
    disposeEventWiring: input.eventWiring,
    runContext: input.host.runContext,
    toolDecision: input.tools.toolDecision,
    delegateCtx: input.delegateCtx.delegateCtx,
    allTools: input.delegateCtx.allTools,
    systemMessages: input.systemMessages.systemMessages,
    agentRef: input.host.agentRef
  }
}
