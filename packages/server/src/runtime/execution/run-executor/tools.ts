import { EventType, governTool, type DelegateContext, type EngineServices, type Tool } from "@mia/agent"
import { readToolEntityId } from "@mia/shared-types"
import { resetEffectSeq } from "../../../infra/effects/index.js"
import { broadcast, broadcastTrace, broadcastTraceLoose } from "../../../infra/events/broadcaster.js"
import { retrieveContext } from "../../../infra/persistence/memory.js"
import { EMPTY_MEMORY_PER_TIER } from "../../../infra/persistence/memory/tier-context.js"
import { RunPriority } from "../../../infra/queue/run-queue.js"
import { AuditActor } from "../../../internal/enums/audit.js"
import { BusProtocol } from "../../../internal/enums/bus.js"
import { TraceEventKind } from "../../../internal/enums/trace.js"
import { decideSections, filterToolsByGoal } from "../../prompting/decide-sections.js"
import { composePerRunTools, getAllTools } from "../../tooling/registry.js"
import { resolveAskUserPresentation } from "../ask-user-options.js"
import { wrapWithEffects } from "../workspace-effects.js"
import { buildClassificationContext } from "./support.js"
import type {
  DelegateRuntimeContext,
  DelegateToolsBundle,
  ToolResolution,
  ToolResolutionContext
} from "./types.js"

const MSSQL_TOOL_TIMEOUT_MS = 120_000
const SYNC_TOOL_TIMEOUT_MS = 240_000
const SYNC_BULK_NO_RETRY = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 1,
  jitterFactor: 0
} as const

const SYNC_LONG_RUNNING_TOOLS = new Set([
  "sync_preview",
  "sync_diff_scan",
  "sync_execute",
  "compare_catalogs"
])

const SYNC_NO_RETRY_TOOLS = new Set(["sync_preview", "sync_diff_scan"])

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
  const { request, signal, activeRun, runWorkspace, perRunHost, runContext, state, policyCtx, services, tracing } =
    ctx
  const governanceServices = createGovernanceServices(services)
  const governRuntimeTool = (tool: Tool) =>
    governTool(tool, governanceServices, state, {
      signal,
      policyContext: policyCtx,
      ...(tool.name === "query_mssql" || tool.name === "explore_mssql_schema"
        ? { timeoutMs: MSSQL_TOOL_TIMEOUT_MS }
        : SYNC_LONG_RUNNING_TOOLS.has(tool.name)
          ? {
              timeoutMs: SYNC_TOOL_TIMEOUT_MS,
              ...(SYNC_NO_RETRY_TOOLS.has(tool.name) ? { retryPolicy: SYNC_BULK_NO_RETRY } : {})
            }
          : {})
    })

  const shouldUseMemory = !(runWorkspace.taskType === "code_generation" && !request.resume)
  let perTier: ToolResolution["perTier"] = { ...EMPTY_MEMORY_PER_TIER }

  if (shouldUseMemory) {
    try {
      const result = await retrieveContext(request.goal, {
        threadId: activeRun?.threadId ?? undefined,
        runId: request.runId,
        upn: activeRun?.ownerUpn ?? undefined
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
  // Rebuild tools from the per-run host so filesystem/shell paths target the
  // isolated execution root — NOT the boot-time orchestrator workspace.
  // `request.tools` is only used for the allowed-name set (visitor allowlist).
  const allowedToolNames = new Set(request.tools.map((tool) => tool.name))
  const hostBoundTools = getAllTools(perRunHost, runContext).filter((tool) => allowedToolNames.has(tool.name))
  const toolFilter = filterToolsByGoal(hostBoundTools, toolDecision)

  if (!toolFilter.passThrough) {
    console.log(
      `[tools] run=${request.runId} dropped ${toolFilter.dropped.length} DB/sync tools for non-DB goal (kept ${toolFilter.tools.length}): ${toolFilter.dropped.join(", ")}`
    )
    const filteredEntry = {
      kind: TraceEventKind.ToolsFiltered,
      dropped: toolFilter.dropped,
      kept: toolFilter.tools.length,
      dbScore: toolDecision.dbScore ?? 0,
      syncTrigger: !!toolDecision.syncIntent,
      reason: `goal classified non-data (dbScore=${toolDecision.dbScore ?? 0}, syncIntent=${!!toolDecision.syncIntent})`
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
  const { request, signal, reportChildUsage, llm, queue, messaging, services, tracing } = ctx
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
      } catch (err: unknown) { console.error("[mia]", err) }
    },
    acquireSlot: (childRunId: string) => queue.acquire(childRunId, RunPriority.High, signal),
    onChildTrace: (entry) => {
      tracing.boundSaveTrace(request.runId, entry)
      if (entry.kind === TraceEventKind.DelegationStart) {
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
          .catch((err: unknown) => { console.error("[mia]", err) })
      } else if (entry.kind === TraceEventKind.DelegationEnd) {
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
          .catch((err: unknown) => { console.error("[mia]", err) })
      } else if (entry.kind === TraceEventKind.DelegationIteration) {
        broadcast({ type: EventType.DelegationIteration, data: { runId: request.runId, ...entry } })
      } else if (entry.kind === TraceEventKind.DelegationParallelStart) {
        broadcast({ type: EventType.DelegationParallelStarted, data: { runId: request.runId, ...entry } })
      } else if (entry.kind === TraceEventKind.DelegationParallelEnd) {
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
  governedTools: Tool[]
): import("@mia/agent").ExecutableTool[] {
  const { request, signal, activeRun, state, tracing, interaction, messaging, services } = ctx
  const governanceServices = createGovernanceServices(services)

  const allToolsBase = composePerRunTools(governedTools, {
    runId: request.runId,
    agentName: "Universal Agent",
    busTools: messaging.createChildTools(request.runId, "Universal Agent"),
    govern: (tool, opts) =>
      governTool(tool, governanceServices, state, {
        signal,
        ...(opts ?? {})
      }),
    askUserResolve: (question, options, sensitive) => {
      const match = interaction.clarifications.matchQuestion(request.runId, question)
      const presentation = resolveAskUserPresentation(question, options, match)
      tracing.boundSaveTrace(request.runId, {
        kind: TraceEventKind.UserInputRequest,
        question: presentation.question,
        options: presentation.options,
        sensitive
      })
      broadcast({
        type: EventType.UserInputRequired,
        data: {
          runId: request.runId,
          question: presentation.question,
          options: presentation.options ?? [],
          sensitive
        }
      })
      if (match) interaction.clarifications.setPending(request.runId, match, presentation.question)
      return new Promise<string>((resolve) => {
        interaction.registerPendingInput(request.runId, { resolve })
      })
    },
    threadId: activeRun?.threadId ?? null,
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
              broadcast({
                type: EventType.SyncAgentPreview,
                data: {
                  runId: request.runId,
                  planId,
                  entityType: String(args["entityType"] ?? ""),
                  entityId: readToolEntityId(args),
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
          const result = await tool.execute(args)
          const success = typeof result === "string" && result.toLowerCase().includes("successfully")
          // executeSync records finish (with execute totals) via the run sink.
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
  const allTools = composeExecutionTools(ctx, governedTools)

  return { allTools, delegateCtx }
}
