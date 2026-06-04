import {
    computeAutoDetectedExcludeDirs,
    configureAgent,
    createRun,
    EventType,
    getCatalog,
    governTool,
    makeRunContext,
    PolicyRole,
    PolicyRunMode,
    runStarted,
    startRunningPure,
    type AgentHost,
    type DelegateContext,
    type HostedPolicyContext,
    type RunState,
    type Tool,
} from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { SyncRunStatus } from "@mia/sync"
import { createServerBrowserCredentialProvider } from "../../../../adapters/browser/credential-provider.js"
import { createServerBrowserHandoffProvider } from "../../../../adapters/browser/handoff-provider.js"
import { createServerBrowserContextProvider } from "../../../../adapters/browser/provider.js"
import { resetEffectSeq } from "../../../../adapters/effects/index.js"
import { createServerAttachmentService } from "../../../../adapters/persistence/attachments.js"
import { ingestAgentNote, listTableVerdicts, lookupToolKnowledge, renderCachedHeader, retrieveContext, saveToolKnowledge } from "../../../../adapters/persistence/memory.js"
import * as db from "../../../../adapters/persistence/sqlite.js"
import { createBusTools } from "../../../../agent-bus.js"
import { AuditActor } from "../../../../enums/audit.js"
import { BusProtocol } from "../../../../enums/bus.js"
import { TrajectoryEventKind } from "../../../../enums/trajectory.js"
import { broadcast, broadcastTrace, broadcastTraceLoose } from "../../../../event-broadcaster.js"
import { composePerRunTools, getAllTools } from "../../../../tools.js"
import { wireEventBroadcasting } from "../../../core/coordination/event-wiring.js"
import { loadCandidateVerdicts, loadKnownObjects } from "../../../core/data-blocks/known-objects.js"
import { loadPriorResults } from "../../../core/data-blocks/prior-results-block.js"
import { loadPriorTurns } from "../../../core/data-blocks/prior-turns.js"
import { decideSections, filterToolsByGoal } from "../../../core/decide-sections.js"
import { buildSystemMessages } from "../../../core/system-messages.js"
import { RunPriority } from "../../queue/run-queue.js"
import { prepareRunWorkspace } from "../../workspace/run-workspace.js"
import { enforceClarificationUiOptions } from "../ask-user-options.js"
import { createNotification, persistRun, saveTrace } from "../persistence.js"
import { wrapWithEffects } from "../workspace-effects.js"
import { buildClassificationContext } from "./support.js"
import type { ActiveRunRecord, AgentRef, ExecuteRunInput, ExecutionEnvironment, ProgressState, RunWorkspace } from "./types.js"

const MSSQL_TOOL_TIMEOUT_MS = 120_000

function createRunContextForExecution(activeRun: ActiveRunRecord | undefined, runId: string, controller: AbortController) {
  return makeRunContext({
    signal: controller.signal,
    memory: {
      writeNote: (payload) => {
        try {
          ingestAgentNote({
            subject: payload.subject,
            claim: payload.claim,
            evidence: payload.evidence,
            category: payload.category,
            sessionId: activeRun?.sessionId ?? null,
            runId,
            upn: activeRun?.ownerUpn ?? null,
          })
        } catch {
          // Side-channel persistence must not break the run.
        }
      },
    },
  })
}

function createPolicyContext(runId: string, activeRun: ActiveRunRecord | undefined, runWorkspace: RunWorkspace): HostedPolicyContext {
  const role = activeRun?.role ?? PolicyRole.Admin
  return {
    runId,
    runMode: role === PolicyRole.HostedUser ? PolicyRunMode.Hosted : PolicyRunMode.Developer,
    role,
    sandboxRoot: runWorkspace.executionRoot,
    actorUpn: activeRun?.ownerUpn ?? null,
    sessionId: activeRun?.sessionId ?? null,
  }
}

function createPerRunHost(input: ExecuteRunInput, activeRun: ActiveRunRecord | undefined, runWorkspace: RunWorkspace, policyCtx: HostedPolicyContext): AgentHost {
  return configureAgent({
    ...(input.ctx.bootHostDeps.browserCredentialReader ? { browserCredentialReader: input.ctx.bootHostDeps.browserCredentialReader } : {}),
    ...(input.ctx.bootHostDeps.browserHandoffStore ? { browserHandoffStore: input.ctx.bootHostDeps.browserHandoffStore } : {}),
    ...(input.ctx.bootHostDeps.shellClient ? { shellClient: input.ctx.bootHostDeps.shellClient } : {}),
    ...(input.ctx.bootHostDeps.shellSandboxStrict !== undefined ? { shellSandboxStrict: input.ctx.bootHostDeps.shellSandboxStrict } : {}),
    ...(input.ctx.bootHostDeps.browserCheckClient ? { browserCheckClient: input.ctx.bootHostDeps.browserCheckClient } : {}),
    ...(input.ctx.bootHostDeps.mssqlDatabases ? { mssqlDatabases: input.ctx.bootHostDeps.mssqlDatabases } : {}),
    ...(input.ctx.bootHostDeps.mssqlDefaultConnection ? { mssqlDefaultConnection: input.ctx.bootHostDeps.mssqlDefaultConnection } : {}),
    ...(input.ctx.bootHostDeps.catalogInstances ? { catalogInstances: input.ctx.bootHostDeps.catalogInstances } : {}),
    ...(input.ctx.bootHostDeps.catalogDefaultCachePath ? { catalogDefaultCachePath: input.ctx.bootHostDeps.catalogDefaultCachePath } : {}),
    ...(input.ctx.bootHostDeps.syncState ? { syncState: input.ctx.bootHostDeps.syncState } : {}),
    attachments: createServerAttachmentService(() => policyCtx),
    browserContextReader: createServerBrowserContextProvider(activeRun?.ownerUpn ?? null),
    browserCredentialReader: createServerBrowserCredentialProvider(activeRun?.ownerUpn ?? null),
    browserHandoffStore: createServerBrowserHandoffProvider(activeRun?.ownerUpn ?? null),
    workspaceRoot: runWorkspace.executionRoot,
    filesystemBasePath: runWorkspace.executionRoot,
    searchFilesBasePath: runWorkspace.executionRoot,
    searchFilesExcludeDirs: new Set(computeAutoDetectedExcludeDirs(runWorkspace.executionRoot)),
    shellCwd: runWorkspace.executionRoot,
    browserCheckCwd: runWorkspace.executionRoot,
    toolKnowledge: {
      lookup: (args) => lookupToolKnowledge(args) as unknown as ReturnType<NonNullable<AgentHost["toolKnowledge"]>["lookup"]>,
      save: (args) => saveToolKnowledge({ ...args, upn: activeRun?.ownerUpn ?? null }),
      renderHeader: (hit, opts) => renderCachedHeader(hit as unknown as Parameters<typeof renderCachedHeader>[0], opts),
    },
    tableVerdicts: {
      list: (args) => listTableVerdicts({ qnames: args.qnames, connection: args.connection }),
    },
  })
}

async function resolveToolSelection(
  input: ExecuteRunInput,
  activeRun: ActiveRunRecord | undefined,
  runWorkspace: RunWorkspace,
  policyCtx: HostedPolicyContext,
  state: RunState,
  boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void,
  debugSeqRef: { value: number },
) {
  const governRuntimeTool = (tool: Tool) => governTool(tool, input.services, state, {
    signal: input.controller.signal,
    policyContext: policyCtx,
    ...((tool.name === "query_mssql" || tool.name === "explore_mssql_schema") ? { timeoutMs: MSSQL_TOOL_TIMEOUT_MS } : {}),
  })

  const shouldUseMemory = !(runWorkspace.taskType === "code_generation" && !input.resume)
  let perTier: { working: string; episodic: string; semantic: string } = { working: "", episodic: "", semantic: "" }
  if (shouldUseMemory) {
    try {
      const result = await retrieveContext(input.goal, {
        sessionId: activeRun?.sessionId ?? undefined,
        runId: input.runId,
        upn: activeRun?.ownerUpn ?? null,
      })
      perTier = result.perTier
    } catch (error) {
      console.warn(`[run ${input.runId}] memory retrieval failed, running without context:`, (error as Error).message)
    }
  }

  const classificationContext = buildClassificationContext({
    resumeMessages: input.resume?.messages,
    working: perTier.working,
    episodic: perTier.episodic,
  })
  const toolDecision = decideSections({ goal: input.goal, memory: perTier, context: classificationContext })
  const toolFilter = filterToolsByGoal(input.tools, toolDecision)
  if (!toolFilter.passThrough) {
    console.log(`[tools] run=${input.runId} dropped ${toolFilter.dropped.length} DB/sync tools for non-DB goal (kept ${toolFilter.tools.length}): ${toolFilter.dropped.join(", ")}`)
    const filteredEntry = {
      kind: TrajectoryEventKind.ToolsFiltered,
      dropped: toolFilter.dropped,
      kept: toolFilter.tools.length,
      dbScore: toolDecision.dbScore ?? 0,
      syncTrigger: !!toolDecision.triggers?.sync,
      reason: `goal classified non-DB (dbScore=${toolDecision.dbScore ?? 0}, sync=${!!toolDecision.triggers?.sync})`,
    } as const
    boundSaveTrace(input.runId, filteredEntry)
    broadcastTrace(input.runId, debugSeqRef.value++, filteredEntry)
  }

  const trackedTools = toolFilter.tools.map((tool) => wrapWithEffects(tool, input.runId, runWorkspace.executionRoot))
  const governedTools = trackedTools.map(governRuntimeTool)

  return { governedTools, perTier, toolDecision }
}

function createDelegateContext(
  input: ExecuteRunInput,
  envBase: {
    activeRun: ActiveRunRecord | undefined
    runContext: ReturnType<typeof makeRunContext>
    perRunHost: AgentHost
    state: RunState
    boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void
  },
  governedTools: Tool[],
  agentRef: AgentRef,
): DelegateContext {
  const maxDelegationDepth = Number(process.env["DELEGATION_MAX_DEPTH"]) || 3
  const lastStatusIter = new Map<string, number>()

  return {
    llm: input.ctx.llm,
    availableTools: governedTools,
    depth: 0,
    maxDepth: maxDelegationDepth,
    signal: input.controller.signal,
    buildChildTools: (childRunId, childAgentName) => createBusTools(input.bus, childRunId, childAgentName),
    onChildIteration: (info) => {
      const last = lastStatusIter.get(info.childRunId) ?? 0
      if (info.iteration !== 1 && info.iteration - last < 5) return
      lastStatusIter.set(info.childRunId, info.iteration)
      const previewBits: string[] = []
      if (info.toolNames.length > 0) previewBits.push(`tools=[${info.toolNames.join(",")}]`)
      if (info.content) previewBits.push(info.content.replace(/\s+/g, " ").trim())
      const preview = previewBits.join(" ").slice(0, 240)
      try {
        input.bus.publish({
          topic: `${input.runId}-status`,
          fromRunId: info.childRunId,
          fromAgent: info.childAgentName,
          content: `iteration ${info.iteration}/${info.maxIterations}${preview ? ": " + preview : ""}`,
          protocol: BusProtocol.Status,
        })
      } catch {
        // Bus publish must not break the run.
      }
    },
    acquireSlot: (childRunId: string) => input.ctx.queue.acquire(childRunId, RunPriority.High, input.controller.signal),
    resolveAgent: (agentId) => {
      const def = db.getAgentDefinition(agentId)
      if (!def) return null
      const agentTools = getAllTools(envBase.perRunHost, envBase.runContext).map((tool) => governTool(tool, input.services, envBase.state, { signal: input.controller.signal }))
      return { id: def.id, name: def.name, systemPrompt: db.resolveAgentSystemPrompt(def), tools: agentTools }
    },
    onChildTrace: (entry) => {
      envBase.boundSaveTrace(input.runId, entry)
      if (entry.kind === TrajectoryEventKind.DelegationStart) {
        broadcast({ type: EventType.DelegationStarted, data: { runId: input.runId, ...entry } })
        input.services.auditService.log({ actor: AuditActor.Agent, action: "delegation.started", resourceType: "AgentRun", resourceId: input.runId, detail: { goal: entry.goal, depth: entry.depth, tools: entry.tools, agentName: entry.agentName } }).catch(() => {})
      } else if (entry.kind === TrajectoryEventKind.DelegationEnd) {
        broadcast({ type: EventType.DelegationEnded, data: { runId: input.runId, ...entry } })
        input.services.auditService.log({ actor: AuditActor.Agent, action: entry.status === "done" ? "delegation.completed" : "delegation.failed", resourceType: "AgentRun", resourceId: input.runId, detail: { depth: entry.depth, status: entry.status, answer: entry.answer, error: entry.error } }).catch(() => {})
      } else if (entry.kind === TrajectoryEventKind.DelegationIteration) {
        broadcast({ type: EventType.DelegationIteration, data: { runId: input.runId, ...entry } })
      } else if (entry.kind === TrajectoryEventKind.DelegationParallelStart) {
        broadcast({ type: EventType.DelegationParallelStarted, data: { runId: input.runId, ...entry } })
      } else if (entry.kind === TrajectoryEventKind.DelegationParallelEnd) {
        broadcast({ type: EventType.DelegationParallelEnded, data: { runId: input.runId, ...entry } })
      } else if (entry.kind === "thinking") {
        broadcast({ type: EventType.AgentThinking, data: { runId: input.runId, content: entry.text } })
      } else if (typeof entry.kind === "string" && entry.kind.startsWith("planner-delegation")) {
        broadcastTraceLoose(input.runId, Date.now(), entry as { kind: string } & Record<string, unknown>)
      } else if (entry.kind === "llm-request" || entry.kind === "llm-response" || entry.kind === "nudge") {
        broadcastTraceLoose(input.runId, Date.now(), entry as { kind: string } & Record<string, unknown>)
      }
    },
    onChildUsage: (() => {
      const lastSeen = new WeakMap<object, { p: number; c: number; t: number; l: number }>()
      let totalPrompt = 0
      let totalCompletion = 0
      let totalTokens = 0
      let totalLlmCalls = 0
      return (childUsage, childLlmCalls) => {
        const prev = lastSeen.get(childUsage) ?? { p: 0, c: 0, t: 0, l: 0 }
        totalPrompt += childUsage.promptTokens - prev.p
        totalCompletion += childUsage.completionTokens - prev.c
        totalTokens += childUsage.totalTokens - prev.t
        totalLlmCalls += childLlmCalls - prev.l
        lastSeen.set(childUsage, { p: childUsage.promptTokens, c: childUsage.completionTokens, t: childUsage.totalTokens, l: childLlmCalls })
        const agent = agentRef.current
        if (!agent) return
        agent.usage.promptTokens = totalPrompt
        agent.usage.completionTokens = totalCompletion
        agent.usage.totalTokens = totalTokens
        agent.llmCalls = totalLlmCalls
        broadcast({ type: EventType.UsageUpdated, data: { runId: input.runId, promptTokens: totalPrompt, completionTokens: totalCompletion, totalTokens, llmCalls: totalLlmCalls } })
      }
    })(),
    parentSystemPrompt: undefined,
  }
}

function composeExecutionTools(
  input: ExecuteRunInput,
  envBase: {
    activeRun: ActiveRunRecord | undefined
    state: RunState
    boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void
    runWorkspace: RunWorkspace
  },
  delegateCtx: DelegateContext,
  governedTools: Tool[],
): Tool[] {
  const agentName = input.agentId ? (db.getAgentDefinition(input.agentId)?.name ?? "Agent") : "Universal Agent"
  const allToolsBase = composePerRunTools(governedTools, {
    runId: input.runId,
    agentName,
    bus: input.bus,
    delegateCtx,
    govern: (tool, opts) => governTool(tool, input.services, envBase.state, { signal: input.controller.signal, ...(opts ?? {}) }),
    askUserResolve: (question, options, sensitive) => {
      const match = input.ctx.clarifications.matchQuestion(input.runId, question)
      const effectiveOptions = enforceClarificationUiOptions(options, match)
      envBase.boundSaveTrace(input.runId, { kind: TrajectoryEventKind.UserInputRequest, question, options: effectiveOptions, sensitive })
      broadcast({ type: EventType.UserInputRequired, data: { runId: input.runId, question, options: effectiveOptions ?? [], sensitive } })
      if (match) input.ctx.clarifications.setPending(input.runId, match, question)
      return new Promise<string>((resolve) => {
        input.ctx.pendingInputs.set(input.runId, { resolve })
      })
    },
    sessionId: envBase.activeRun?.sessionId ?? null,
    upn: envBase.activeRun?.ownerUpn ?? null,
  })

  const allTools = allToolsBase.map((tool) => {
    if (tool.name === "sync_preview") {
      return {
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const result = await tool.execute(args)
          if (typeof result === "string") {
            const match = result.match(/^Plan\s+([a-f0-9-]{36})\b/)
            if (match) {
              const planId = match[1]
              const totalsMatch = result.match(/Totals:\s*\+(\d+)\s*~(\d+)\s*-(\d+)\s*\(=(\d+)\s*unchanged\)\s*across\s*(\d+)/)
              const previewTotals = totalsMatch
                ? { insert: Number(totalsMatch[1]), update: Number(totalsMatch[2]), delete: Number(totalsMatch[3]), unchanged: Number(totalsMatch[4]), tablesCount: Number(totalsMatch[5]) }
                : {}
              try {
                db.recordSyncRunStart({
                  planId,
                  entityType: String(args["entityType"] ?? ""),
                  entityId: String(args["entityId"] ?? ""),
                  entityDisplayName: null,
                  source: String(args["source"] ?? ""),
                  target: String(args["target"] ?? ""),
                  actorUpn: "agent",
                  previewTotals,
                })
              } catch (error) {
                console.warn("[sync-history] recordSyncRunStart failed:", error instanceof Error ? error.message : error)
              }
              broadcast({
                type: EventType.SyncAgentPreview,
                data: {
                  runId: input.runId,
                  planId,
                  entityType: String(args["entityType"] ?? ""),
                  entityId: String(args["entityId"] ?? ""),
                  source: String(args["source"] ?? ""),
                  target: String(args["target"] ?? ""),
                },
              })
            }
          }
          return result
        },
      }
    }

    if (tool.name === "sync_execute") {
      return {
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const planId = String(args["planId"] ?? "")
          broadcast({ type: EventType.SyncAgentExecuteStarted, data: { runId: input.runId, planId } })
          const startedAt = Date.now()
          const result = await tool.execute(args)
          const success = typeof result === "string" && result.toLowerCase().includes("successfully")
          try {
            db.recordSyncRunFinish({
              planId,
              status: success ? SyncRunStatus.Success : SyncRunStatus.Failed,
              error: success ? null : (typeof result === "string" ? result : null),
              durationMs: Date.now() - startedAt,
            })
          } catch (error) {
            console.warn("[sync-history] recordSyncRunFinish failed:", error instanceof Error ? error.message : error)
          }
          broadcast({
            type: EventType.SyncAgentExecuteCompleted,
            data: { runId: input.runId, planId, success, result: typeof result === "string" ? result : String(result) },
          })
          return result
        },
      }
    }

    return tool
  })

  resetEffectSeq(input.runId)
  return allTools
}

async function buildExecutionSystemMessages(
  input: ExecuteRunInput,
  envBase: {
    activeRun: ActiveRunRecord | undefined
    runWorkspace: RunWorkspace
    perRunHost: AgentHost
    allTools: Tool[]
    boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void
    debugSeqRef: { value: number }
  },
  perTier: { working: string; episodic: string; semantic: string },
) {
  const priorTurns = (envBase.activeRun?.sessionId && envBase.activeRun?.ownerUpn && envBase.runWorkspace.taskType !== "code_generation")
    ? loadPriorTurns({
        sessionId: envBase.activeRun.sessionId,
        excludeRunId: input.runId,
        upn: envBase.activeRun.ownerUpn,
        limit: 3,
      })
    : []

  const priorResults = (envBase.activeRun?.sessionId && envBase.runWorkspace.taskType !== "code_generation")
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
        return loadCandidateVerdicts({ goal: input.goal, catalog: getCatalog(envBase.perRunHost), upn: envBase.activeRun?.ownerUpn ?? null })
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
          suggestedQuestion: event.finding.suggestedQuestion,
        } as Record<string, unknown>)
      } else {
        envBase.boundSaveTrace(input.runId, {
          kind: TrajectoryEventKind.ClarificationLlmPlannerInvoked,
          findingsCount: event.findingsCount,
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
    coordinationTopic: `${input.runId}-status`,
  })

  const effectivePrompt = systemMessages.map((message) => message.content).join("\n\n")
  envBase.boundSaveTrace(input.runId, { kind: TrajectoryEventKind.SystemPrompt, text: effectivePrompt || "(no system prompt)" })
  broadcastTrace(input.runId, envBase.debugSeqRef.value++, { kind: TrajectoryEventKind.SystemPrompt, text: effectivePrompt || "(no system prompt)" })
  const toolsResolvedEntry = { kind: TrajectoryEventKind.ToolsResolved, tools: envBase.allTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }
  envBase.boundSaveTrace(input.runId, toolsResolvedEntry)
  broadcastTrace(input.runId, envBase.debugSeqRef.value++, toolsResolvedEntry)
  return { effectivePrompt, systemMessages }
}

export async function prepareExecutionEnvironment(input: ExecuteRunInput): Promise<ExecutionEnvironment> {
  const actor = "user"
  const progress: ProgressState = { lastMessages: [], lastIteration: 0, prevTotalTokens: 0 }
  const baseWorkspace = input.ctx.workspace ?? process.cwd()
  const preActiveRun = input.ctx.activeRuns.get(input.runId)
  const runWorkspace = await prepareRunWorkspace({
    runId: input.runId,
    sourceRoot: baseWorkspace,
    goal: input.goal,
    resume: !!input.resume,
    role: preActiveRun?.role ?? PolicyRole.Admin,
  })
  const activeRun = input.ctx.activeRuns.get(input.runId)
  if (activeRun) activeRun.workspace = runWorkspace

  const state: RunState = {
    run: createRun("agent-session", { goal: input.goal }, input.runId),
    actor,
    stepCounter: input.resume?.iteration ?? 0,
  }

  const boundSaveTrace = (runId: string, entry: Record<string, unknown>) => saveTrace(input.ctx.activeRuns, runId, entry)
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

  const disposeEventWiring = wireEventBroadcasting(input.services, input.runId, () => state.run, boundSaveTrace, createNotification)
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
      workspaceRoot: runWorkspace.executionRoot,
    },
  })
  persistCurrentRun()

  const runContext = createRunContextForExecution(activeRun, input.runId, input.controller)
  const policyCtx = createPolicyContext(input.runId, activeRun, runWorkspace)
  const perRunHost = createPerRunHost(input, activeRun, runWorkspace, policyCtx)
  const debugSeqRef = { value: 0 }
  const agentRef: AgentRef = { current: null }
  const { governedTools, perTier, toolDecision } = await resolveToolSelection(input, activeRun, runWorkspace, policyCtx, state, boundSaveTrace, debugSeqRef)
  const delegateCtx = createDelegateContext(input, { activeRun, runContext, perRunHost, state, boundSaveTrace }, governedTools, agentRef)
  const allTools = composeExecutionTools(input, { activeRun, state, boundSaveTrace, runWorkspace }, delegateCtx, governedTools)
  const { effectivePrompt, systemMessages } = await buildExecutionSystemMessages(input, { activeRun, runWorkspace, perRunHost, allTools, boundSaveTrace, debugSeqRef }, perTier)
  delegateCtx.parentSystemPrompt = effectivePrompt

  return {
    actor,
    activeRun,
    runWorkspace,
    state,
    progress,
    debugSeqRef,
    boundSaveTrace,
    persistCurrentRun,
    markRunStarted,
    disposeEventWiring,
    runContext,
    toolDecision,
    delegateCtx,
    allTools,
    systemMessages,
    agentRef,
  }
}