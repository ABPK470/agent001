import { createRun, PolicyRole, runStarted, startRunningPure, type RunState } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { prepareRunWorkspace } from "../../../../bootstrap/workspace.js"
import { wireEventBroadcasting } from "../../core/coordination/event-wiring.js"
import { persistRun } from "../persistence.js"
import type {
  DelegateToolsBundle,
  ExecuteRunCommand,
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

export async function prepareWorkspace(command: ExecuteRunCommand): Promise<WorkspacePreparation> {
  const { request, runtime } = command
  const baseWorkspace = runtime.workspaceRoot ?? process.cwd()
  const preActiveRun = runtime.registry.getActiveRun(request.runId)

  const runWorkspace = await prepareRunWorkspace({
    runId: request.runId,
    sourceRoot: baseWorkspace,
    goal: request.goal,
    resume: !!request.resume,
    role: preActiveRun?.role ?? PolicyRole.Admin
  })

  runtime.registry.assignWorkspace(request.runId, runWorkspace)
  const activeRun = runtime.registry.getActiveRun(request.runId)
  return { activeRun, runWorkspace }
}

export function createExecutionState(command: ExecuteRunCommand): ExecutionStateBundle {
  const { request } = command
  const actor = "user"
  const progress: ProgressState = { lastMessages: [], lastIteration: 0, prevTotalTokens: 0 }
  const state: RunState = {
    run: createRun("agent-session", { goal: request.goal }, request.runId),
    actor,
    stepCounter: request.resume?.iteration ?? 0
  }

  return { actor, progress, state }
}

export function createRunPersistence(
  command: ExecuteRunCommand,
  state: RunState,
  actor: string,
  runWorkspace: RunWorkspace
): RunPersistenceBundle {
  const { request, runtime, sideEffects } = command
  const boundSaveTrace = (runId: string, entry: Record<string, unknown>) =>
    runtime.registry.appendTrace(runId, entry)

  const persistCurrentRun = (answer?: string, error?: string): void => {
    persistRun(state.run, request.goal, request.agentId, request.resume?.parentRunId, answer, error)
  }

  const saveCurrentRun = async (): Promise<void> => {
    await sideEffects.runRepo.save(state.run)
  }

  const markRunStarted = async (): Promise<void> => {
    if (state.run.status !== RunStatus.Pending) return
    state.run = startRunningPure(state.run, state.run.steps)
    await saveCurrentRun()
    persistCurrentRun()
    await sideEffects.eventBus.publish(runStarted(state.run.id, "agent-session"))
  }

  const initialize = async (): Promise<void> => {
    await saveCurrentRun()
    await sideEffects.auditLog.log({
      actor,
      action: "agent.started",
      resourceType: "AgentRun",
      resourceId: state.run.id,
      detail: {
        goal: request.goal,
        tools: request.tools.map((tool) => tool.name),
        agentId: request.agentId,
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
  command: ExecuteRunCommand,
  state: RunState,
  saveTrace: (runId: string, entry: Record<string, unknown>) => void
) {
  return wireEventBroadcasting(
    {
      eventBus: command.sideEffects.eventBus,
      auditLog: command.sideEffects.auditLog
    },
    command.request.runId,
    state,
    saveTrace,
    command.sideEffects.notifications.notify
  )
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
    systemMessages: input.systemMessages.systemMessages
  }
}
