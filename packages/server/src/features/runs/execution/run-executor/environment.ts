import {
  assembleExecutionEnvironment,
  createExecutionState,
  createRunPersistence,
  prepareWorkspace,
  wireExecutionEvents
} from "./assembly.js"
import { createPerRunHost } from "./host.js"
import { buildExecutionSystemMessages } from "./system-messages.js"
import { createDelegateContext, resolveExecutionTools } from "./tools.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "./types.js"

export async function prepareExecutionEnvironment(
  command: ExecuteRunCommand,
  getParentAgent: () => import("@mia/agent").Agent | null
): Promise<ExecutionEnvironment> {
  const { request, runtime, sideEffects } = command
  const workspace = await prepareWorkspace(command)
  const state = createExecutionState(command)
  const persistence = createRunPersistence(command, state.state, state.actor, workspace.runWorkspace)
  const eventWiring = wireExecutionEvents(command, state.state, persistence.boundSaveTrace)

  await persistence.initialize()

  const host = createPerRunHost(command, workspace.activeRun, workspace.runWorkspace)
  const tools = await resolveExecutionTools({
    request,
    signal: runtime.controller.signal,
    activeRun: workspace.activeRun,
    runWorkspace: workspace.runWorkspace,
    state: state.state,
    policyCtx: host.policyCtx,
    services: sideEffects,
    tracing: {
      boundSaveTrace: persistence.boundSaveTrace,
      debugSeqRef: host.debugSeqRef
    }
  })
  const delegateCtx = createDelegateContext(
    {
      request,
      signal: runtime.controller.signal,
      activeRun: workspace.activeRun,
      state: state.state,
      runContext: host.runContext,
      perRunHost: host.perRunHost,
      getParentAgent,
      llm: runtime.interaction.llm,
      queue: runtime.queue,
      interaction: runtime.interaction,
      messaging: runtime.messaging,
      services: sideEffects,
      tracing: {
        boundSaveTrace: persistence.boundSaveTrace
      }
    },
    tools.governedTools
  )
  const systemMessages = await buildExecutionSystemMessages(
    {
      request,
      interaction: runtime.interaction,
      messaging: runtime.messaging
    },
    {
      activeRun: workspace.activeRun,
      runWorkspace: workspace.runWorkspace,
      perRunHost: host.perRunHost,
      allTools: delegateCtx.allTools,
      boundSaveTrace: persistence.boundSaveTrace,
      debugSeqRef: host.debugSeqRef
    },
    tools.perTier
  )
  delegateCtx.delegateCtx.parentSystemPrompt = systemMessages.effectivePrompt

  return assembleExecutionEnvironment({
    workspace,
    state,
    persistence,
    eventWiring,
    host,
    tools,
    delegateCtx,
    systemMessages
  })
}
