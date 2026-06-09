import { EventType, governTool, type DelegateContext, type Tool } from "@mia/agent"
import { SyncRunStatus } from "@mia/sync"
import { resetEffectSeq } from "../../../../platform/effects/index.js"
import { broadcast, broadcastTrace, broadcastTraceLoose } from "../../../../platform/events/broadcaster.js"
import { retrieveContext } from "../../../../platform/persistence/memory.js"
import * as db from "../../../../platform/persistence/sqlite.js"
import { createBusTools } from "../../../../platform/queue/agent-bus.js"
import { RunPriority } from "../../../../platform/queue/run-queue.js"
import { AuditActor } from "../../../../shared/enums/audit.js"
import { BusProtocol } from "../../../../shared/enums/bus.js"
import { TrajectoryEventKind } from "../../../../shared/enums/trajectory.js"
import { composePerRunTools, getAllTools } from "../../../agents/tools.js"
import { decideSections, filterToolsByGoal } from "../../core/decide-sections.js"
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

export async function resolveExecutionTools(ctx: ToolResolutionContext): Promise<ToolResolution> {
  const { command, activeRun, runWorkspace, state, policyCtx, tracing } = ctx
  const { request, runtime, sideEffects } = command
  const governRuntimeTool = (tool: Tool) =>
    governTool(tool, sideEffects.engine, state, {
      signal: runtime.controller.signal,
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
  const { command, runContext, perRunHost, state, agentRef, tracing } = ctx
  const { request, runtime, sideEffects } = command
  const maxDelegationDepth = Number(process.env["DELEGATION_MAX_DEPTH"]) || 3
  const lastStatusIter = new Map<string, number>()

  return {
    llm: runtime.orchestrator.llm,
    availableTools: governedTools,
    depth: 0,
    maxDepth: maxDelegationDepth,
    signal: runtime.controller.signal,
    buildChildTools: (childRunId, childAgentName) => createBusTools(runtime.bus, childRunId, childAgentName),
    onChildIteration: (info) => {
      const last = lastStatusIter.get(info.childRunId) ?? 0
      if (info.iteration !== 1 && info.iteration - last < 5) return
      lastStatusIter.set(info.childRunId, info.iteration)
      const previewBits: string[] = []
      if (info.toolNames.length > 0) previewBits.push(`tools=[${info.toolNames.join(",")}]`)
      if (info.content) previewBits.push(info.content.replace(/\s+/g, " ").trim())
      const preview = previewBits.join(" ").slice(0, 240)
      try {
        runtime.bus.publish({
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
    acquireSlot: (childRunId: string) =>
      runtime.orchestrator.queue.acquire(childRunId, RunPriority.High, runtime.controller.signal),
    resolveAgent: (agentId) => {
      const def = db.getAgentDefinition(agentId)
      if (!def) return null
      const agentTools = getAllTools(perRunHost, runContext).map((tool) =>
        governTool(tool, sideEffects.engine, state, { signal: runtime.controller.signal })
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
        sideEffects.engine.auditService
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
        sideEffects.engine.auditService
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
        lastSeen.set(childUsage, {
          p: childUsage.promptTokens,
          c: childUsage.completionTokens,
          t: childUsage.totalTokens,
          l: childLlmCalls
        })
        const agent = agentRef.current
        if (!agent) return
        agent.usage.promptTokens = totalPrompt
        agent.usage.completionTokens = totalCompletion
        agent.usage.totalTokens = totalTokens
        agent.llmCalls = totalLlmCalls
        broadcast({
          type: EventType.UsageUpdated,
          data: {
            runId: request.runId,
            promptTokens: totalPrompt,
            completionTokens: totalCompletion,
            totalTokens,
            llmCalls: totalLlmCalls
          }
        })
      }
    })(),
    parentSystemPrompt: undefined
  }
}

function composeExecutionTools(
  ctx: DelegateRuntimeContext,
  delegateCtx: DelegateContext,
  governedTools: Tool[]
): import("@mia/agent").ExecutableTool[] {
  const { command, activeRun, state, tracing } = ctx
  const { request, runtime, sideEffects } = command
  const agentName = request.agentId
    ? (db.getAgentDefinition(request.agentId)?.name ?? "Agent")
    : "Universal Agent"

  const allToolsBase = composePerRunTools(governedTools, {
    runId: request.runId,
    agentName,
    bus: runtime.bus,
    delegateCtx,
    govern: (tool, opts) =>
      governTool(tool, sideEffects.engine, state, {
        signal: runtime.controller.signal,
        ...(opts ?? {})
      }),
    askUserResolve: (question, options, sensitive) => {
      const match = runtime.orchestrator.clarifications.matchQuestion(request.runId, question)
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
      if (match) runtime.orchestrator.clarifications.setPending(request.runId, match, question)
      return new Promise<string>((resolve) => {
        runtime.orchestrator.pendingInputs.set(request.runId, { resolve })
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
