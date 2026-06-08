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
import type { ExecuteRunInput, ExecutionEnvironment } from "./types.js"

export async function prepareExecutionEnvironment(input: ExecuteRunInput): Promise<ExecutionEnvironment> {
  const workspace = await prepareWorkspace(input)
  const state = createExecutionState(input)
  const persistence = createRunPersistence(input, state.state, state.actor, workspace.runWorkspace)
  const eventWiring = wireExecutionEvents(input, state.state, persistence.boundSaveTrace)

  await persistence.initialize()

  const host = createPerRunHost(input, workspace.activeRun, workspace.runWorkspace)
  const tools = await resolveExecutionTools(
    input,
    workspace.activeRun,
    workspace.runWorkspace,
    host.policyCtx,
    state.state,
    persistence.boundSaveTrace,
    host.debugSeqRef
  )
  const delegateCtx = createDelegateContext(
    input,
    {
      activeRun: workspace.activeRun,
      runContext: host.runContext,
      perRunHost: host.perRunHost,
      state: state.state,
      boundSaveTrace: persistence.boundSaveTrace,
      runWorkspace: workspace.runWorkspace
    },
    tools.governedTools,
    host.agentRef
  )
  const systemMessages = await buildExecutionSystemMessages(
    input,
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
