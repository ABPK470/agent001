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

export async function prepareExecutionEnvironment(command: ExecuteRunCommand): Promise<ExecutionEnvironment> {
  const workspace = await prepareWorkspace(command)
  const state = createExecutionState(command)
  const persistence = createRunPersistence(command, state.state, state.actor, workspace.runWorkspace)
  const eventWiring = wireExecutionEvents(command, state.state, persistence.boundSaveTrace)

  await persistence.initialize()

  const host = createPerRunHost(command, workspace.activeRun, workspace.runWorkspace)
  const tools = await resolveExecutionTools({
    command,
    activeRun: workspace.activeRun,
    runWorkspace: workspace.runWorkspace,
    state: state.state,
    policyCtx: host.policyCtx,
    tracing: {
      boundSaveTrace: persistence.boundSaveTrace,
      debugSeqRef: host.debugSeqRef
    }
  })
  const delegateCtx = createDelegateContext(
    {
      command,
      activeRun: workspace.activeRun,
      state: state.state,
      runContext: host.runContext,
      perRunHost: host.perRunHost,
      agentRef: host.agentRef,
      tracing: {
        boundSaveTrace: persistence.boundSaveTrace
      }
    },
    tools.governedTools
  )
  const systemMessages = await buildExecutionSystemMessages(
    command,
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
