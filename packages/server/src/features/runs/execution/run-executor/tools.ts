import { EventType, governTool, type DelegateContext, type EngineServices, type Tool } from "@mia/agent"
import { SyncRunStatus } from "@mia/sync"
import { resetEffectSeq } from "../../../../platform/effects/index.js"
import { broadcast, broadcastTrace, broadcastTraceLoose } from "../../../../platform/events/broadcaster.js"
import { retrieveContext } from "../../../../platform/persistence/memory.js"
import * as db from "../../../../platform/persistence/sqlite.js"
import { RunPriority } from "../../../../platform/queue/run-queue.js"
import { AuditActor } from "../../../../shared/enums/audit.js"
import { BusProtocol } from "../../../../shared/enums/bus.js"
import { TrajectoryEventKind } from "../../../../shared/enums/trajectory.js"
import { decideSections, filterToolsByGoal } from "../../core/decide-sections.js"
import { composePerRunTools, getAllTools } from "../../tooling/registry.js"
import { enforceClarificationUiOptions } from "../ask-user-options.js"
import { wrapWithEffects } from "../workspace-effects.js"
import { buildClassificationContext } from "./support.js"
import type {
  DelegateRuntimeContext,
  DelegateToolsBundle,
  ToolResolution,
  ToolResolutionContext
} from "./types.js"

const MSSQL_TOOL_TIMEOUT_MS = 120_000

function createGovernanceServices(services: ToolResolutionContext["services"]): EngineServices {
  return {
    runRepo: services.runRepo,
    auditService: services.auditLog,
    policyEvaluator: services.policyEvaluator,
    learner: services.learner,
    eventBus: services.eventBus
  }
}

export async function resolveExecutionTools(ctx: ToolResolutionContext): Promise<ToolResolution> {
  const { request, signal, activeRun, runWorkspace, state, policyCtx, services, tracing } = ctx
  const governanceServices = createGovernanceServices(services)
  const governRuntimeTool = (tool: Tool) =>
    governTool(tool, governanceServices, state, {
      signal,
      policyContext: policyCtx,
      ...(tool.name === "query_mssql" || tool.name === "explore_mssql_schema"
        ? { timeoutMs: MSSQL_TOOL_TIMEOUT_MS }
        : {})
    })

  const shouldUseMemory = !(runWorkspace.taskType === "code_generation" && !request.resume)
  let perTier: ToolResolution["perTier"] = {
    working: "",
    episodic: "",
    semantic: ""
  }

  if (shouldUseMemory) {
    try {
      const result = await retrieveContext(request.goal, {
        sessionId: activeRun?.sessionId ?? undefined,
        runId: request.runId,
        upn: activeRun?.ownerUpn ?? null
      })
      perTier = result.perTier
    } catch (error) {
      console.warn(
        `[run ${request.runId}] memory retrieval failed, running without context:`,
        (error as Error).message
      )
    }
  }

  const classificationContext = buildClassificationContext({
    resumeMessages: request.resume?.messages,
    working: perTier.working,
    episodic: perTier.episodic
  })
  const toolDecision = decideSections({ goal: request.goal, memory: perTier, context: classificationContext })
  const toolFilter = filterToolsByGoal(request.tools, toolDecision)

  if (!toolFilter.passThrough) {
    console.log(
      `[tools] run=${request.runId} dropped ${toolFilter.dropped.length} DB/sync tools for non-DB goal (kept ${toolFilter.tools.length}): ${toolFilter.dropped.join(", ")}`
    )
    const filteredEntry = {
      kind: TrajectoryEventKind.ToolsFiltered,
      dropped: toolFilter.dropped,
      kept: toolFilter.tools.length,
      dbScore: toolDecision.dbScore ?? 0,
      syncTrigger: !!toolDecision.triggers?.sync,
      reason: `goal classified non-DB (dbScore=${toolDecision.dbScore ?? 0}, sync=${!!toolDecision.triggers?.sync})`
    } as const
    tracing.boundSaveTrace(request.runId, filteredEntry)
    broadcastTrace(request.runId, tracing.debugSeqRef.value++, filteredEntry)
  }

  const trackedTools = toolFilter.tools.map((tool) =>
    wrapWithEffects(tool, request.runId, runWorkspace.executionRoot)
  )
  const governedTools = trackedTools.map(governRuntimeTool)

  return { governedTools, perTier, toolDecision }
}

function buildDelegateContext(ctx: DelegateRuntimeContext, governedTools: Tool[]): DelegateContext {
  const {
    request,
    signal,
    runContext,
    perRunHost,
    state,
    reportChildUsage,
    llm,
    queue,
    messaging,
    services,
    tracing
  } = ctx
  const governanceServices = createGovernanceServices(services)
  const maxDelegationDepth = Number(process.env["DELEGATION_MAX_DEPTH"]) || 3
  const lastStatusIter = new Map<string, number>()

  return {
    llm,
    availableTools: governedTools,
    depth: 0,
    maxDepth: maxDelegationDepth,
    signal,
    buildChildTools: (childRunId, childAgentName) => messaging.createChildTools(childRunId, childAgentName),
    onChildIteration: (info) => {
      const last = lastStatusIter.get(info.childRunId) ?? 0
      if (info.iteration !== 1 && info.iteration - last < 5) return
      lastStatusIter.set(info.childRunId, info.iteration)
      const previewBits: string[] = []
      if (info.toolNames.length > 0) previewBits.push(`tools=[${info.toolNames.join(",")}]`)
      if (info.content) previewBits.push(info.content.replace(/\s+/g, " ").trim())
      const preview = previewBits.join(" ").slice(0, 240)
      try {
        messaging.publish({
          topic: `${request.runId}-status`,
          fromRunId: info.childRunId,
          fromAgent: info.childAgentName,
          content: `iteration ${info.iteration}/${info.maxIterations}${preview ? ": " + preview : ""}`,
          protocol: BusProtocol.Status
        })
      } catch {
        // Bus publish must not break the run.
      }
    },
    acquireSlot: (childRunId: string) => queue.acquire(childRunId, RunPriority.High, signal),
    resolveAgent: (agentId) => {
      const def = db.getAgentDefinition(agentId)
      if (!def) return null
      const agentTools = getAllTools(perRunHost, runContext).map((tool) =>
        governTool(tool, governanceServices, state, { signal })
      )
      return {
        id: def.id,
        name: def.name,
        systemPrompt: db.resolveAgentSystemPrompt(def),
        tools: agentTools
      }
    },
    onChildTrace: (entry) => {
      tracing.boundSaveTrace(request.runId, entry)
      if (entry.kind === TrajectoryEventKind.DelegationStart) {
        broadcast({ type: EventType.DelegationStarted, data: { runId: request.runId, ...entry } })
        services.auditLog
          .log({
            actor: AuditActor.Agent,
            action: "delegation.started",
            resourceType: "AgentRun",
            resourceId: request.runId,
            detail: {
              goal: entry.goal,
              depth: entry.depth,
              tools: entry.tools,
              agentName: entry.agentName
            }
          })
          .catch(() => {})
      } else if (entry.kind === TrajectoryEventKind.DelegationEnd) {
        broadcast({ type: EventType.DelegationEnded, data: { runId: request.runId, ...entry } })
        services.auditLog
          .log({
            actor: AuditActor.Agent,
            action: entry.status === "done" ? "delegation.completed" : "delegation.failed",
            resourceType: "AgentRun",
            resourceId: request.runId,
            detail: {
              depth: entry.depth,
              status: entry.status,
              answer: entry.answer,
              error: entry.error
            }
          })
          .catch(() => {})
      } else if (entry.kind === TrajectoryEventKind.DelegationIteration) {
        broadcast({ type: EventType.DelegationIteration, data: { runId: request.runId, ...entry } })
      } else if (entry.kind === TrajectoryEventKind.DelegationParallelStart) {
        broadcast({ type: EventType.DelegationParallelStarted, data: { runId: request.runId, ...entry } })
      } else if (entry.kind === TrajectoryEventKind.DelegationParallelEnd) {
        broadcast({ type: EventType.DelegationParallelEnded, data: { runId: request.runId, ...entry } })
      } else if (entry.kind === "thinking") {
        broadcast({
          type: EventType.AgentThinking,
          data: { runId: request.runId, content: entry.text }
        })
      } else if (typeof entry.kind === "string" && entry.kind.startsWith("planner-delegation")) {
        broadcastTraceLoose(request.runId, Date.now(), entry as { kind: string } & Record<string, unknown>)
      } else if (entry.kind === "llm-request" || entry.kind === "llm-response" || entry.kind === "nudge") {
        broadcastTraceLoose(request.runId, Date.now(), entry as { kind: string } & Record<string, unknown>)
      }
    },
    onChildUsage: reportChildUsage,
    parentSystemPrompt: undefined
  }
}

function composeExecutionTools(
  ctx: DelegateRuntimeContext,
  delegateCtx: DelegateContext,
  governedTools: Tool[]
): import("@mia/agent").ExecutableTool[] {
  const { request, signal, activeRun, state, tracing, interaction, messaging, services } = ctx
  const governanceServices = createGovernanceServices(services)
  const agentName = request.agentId
    ? (db.getAgentDefinition(request.agentId)?.name ?? "Agent")
    : "Universal Agent"

  const allToolsBase = composePerRunTools(governedTools, {
    runId: request.runId,
    agentName,
    busTools: messaging.createChildTools(request.runId, agentName),
    delegateCtx,
    govern: (tool, opts) =>
      governTool(tool, governanceServices, state, {
        signal,
        ...(opts ?? {})
      }),
    askUserResolve: (question, options, sensitive) => {
      const match = interaction.clarifications.matchQuestion(request.runId, question)
      const effectiveOptions = enforceClarificationUiOptions(options, match)
      tracing.boundSaveTrace(request.runId, {
        kind: TrajectoryEventKind.UserInputRequest,
        question,
        options: effectiveOptions,
        sensitive
      })
      broadcast({
        type: EventType.UserInputRequired,
        data: { runId: request.runId, question, options: effectiveOptions ?? [], sensitive }
      })
      if (match) interaction.clarifications.setPending(request.runId, match, question)
      return new Promise<string>((resolve) => {
        interaction.registerPendingInput(request.runId, { resolve })
      })
    },
    sessionId: activeRun?.sessionId ?? null,
    upn: activeRun?.ownerUpn ?? null
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
              const totalsMatch = result.match(
                /Totals:\s*\+(\d+)\s*~(\d+)\s*-(\d+)\s*\(=(\d+)\s*unchanged\)\s*across\s*(\d+)/
              )
              const previewTotals = totalsMatch
                ? {
                    insert: Number(totalsMatch[1]),
                    update: Number(totalsMatch[2]),
                    delete: Number(totalsMatch[3]),
                    unchanged: Number(totalsMatch[4]),
                    tablesCount: Number(totalsMatch[5])
                  }
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
                  previewTotals
                })
              } catch (error) {
                console.warn(
                  "[sync-history] recordSyncRunStart failed:",
                  error instanceof Error ? error.message : error
                )
              }
              broadcast({
                type: EventType.SyncAgentPreview,
                data: {
                  runId: request.runId,
                  planId,
                  entityType: String(args["entityType"] ?? ""),
                  entityId: String(args["entityId"] ?? ""),
                  source: String(args["source"] ?? ""),
                  target: String(args["target"] ?? "")
                }
              })
            }
          }
          return result
        }
      }
    }

    if (tool.name === "sync_execute") {
      return {
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const planId = String(args["planId"] ?? "")
          broadcast({
            type: EventType.SyncAgentExecuteStarted,
            data: { runId: request.runId, planId }
          })
          const startedAt = Date.now()
          const result = await tool.execute(args)
          const success = typeof result === "string" && result.toLowerCase().includes("successfully")
          try {
            db.recordSyncRunFinish({
              planId,
              status: success ? SyncRunStatus.Success : SyncRunStatus.Failed,
              error: success ? null : typeof result === "string" ? result : null,
              durationMs: Date.now() - startedAt
            })
          } catch (error) {
            console.warn(
              "[sync-history] recordSyncRunFinish failed:",
              error instanceof Error ? error.message : error
            )
          }
          broadcast({
            type: EventType.SyncAgentExecuteCompleted,
            data: {
              runId: request.runId,
              planId,
              success,
              result: typeof result === "string" ? result : String(result)
            }
          })
          return result
        }
      }
    }

    return tool
  })

  resetEffectSeq(request.runId)
  return allTools
}

export function createDelegateContext(
  ctx: DelegateRuntimeContext,
  governedTools: Tool[]
): DelegateToolsBundle {
  const delegateCtx = buildDelegateContext(ctx, governedTools)
  const allTools = composeExecutionTools(ctx, delegateCtx, governedTools)

  return { allTools, delegateCtx }
}
