import {
    Agent,
    askUserTool,
    cancelRun,
    completeRun,
    createDelegateTools,
    createRun,
    failRun,
    governTool,
    runCompleted,
    runFailed,
    runStarted,
    setBrowseKillSignal,
    setFetchKillSignal,
    setMssqlKillSignal,
    setShellSignal,
    spawnChildForPlan,
    startPlanning,
    startRunning,
    type DelegateContext,
    type EngineServices,
    type Message,
    type ResolvedAgent,
    type RunState,
    type Tool,
    type ToolKillManager,
} from "@agent001/agent"
import { AgentBus, createBusTools } from "../agent-bus.js"
import * as db from "../db.js"
import { resetEffectSeq } from "../effects.js"
import { consolidate, extractProcedural, ingestRunTurns, retrieveContext } from "../memory.js"
import type { RunPriority } from "../queue.js"
import { prepareRunWorkspace } from "../run-workspace.js"
import { resolveTools } from "../tools.js"
import { broadcast } from "../ws.js"
import { wireEventBroadcasting } from "./event-wiring.js"
import { createNotification, persistAuditLog, persistRun, persistTokenUsage, saveTrace } from "./persistence.js"
import { handlePlannerTrace } from "./planner-events.js"
import { buildSystemMessages } from "./system-messages.js"
import type { OrchestratorRunCtx } from "./types.js"
import { captureRunWorkspaceDiff, withToolWorkspaceContext, wrapWithEffects } from "./workspace-effects.js"

// ── Run executor ──────────────────────────────────────────────────

export async function executeRunImpl(
  ctx: OrchestratorRunCtx,
  runId: string,
  goal: string,
  tools: Tool[],
  systemPrompt: string | undefined,
  agentId: string | null,
  services: EngineServices,
  controller: AbortController,
  bus: AgentBus,
  resume?: { messages: Message[]; iteration: number; parentRunId: string },
  priority: RunPriority = "normal",
): Promise<void> {
  // Acquire a queue slot (waits if at capacity)
  let releaseSlot: () => void
  try {
    releaseSlot = await ctx.queue.acquire(runId, priority, controller.signal)
  } catch {
    ctx.activeRuns.delete(runId)
    return
  }

  const actor = "user"
  let lastMessages: Message[] = []
  let lastIteration = 0
  const baseWorkspace = ctx.workspace ?? process.cwd()
  const runWorkspace = await prepareRunWorkspace({ runId, sourceRoot: baseWorkspace, goal, resume: !!resume })
  const activeRun = ctx.activeRuns.get(runId)
  if (activeRun) activeRun.workspace = runWorkspace

  // Create tracked workflow run
  const run = createRun("agent-session", { goal })
  ;(run as { id: string }).id = runId
  startPlanning(run)
  startRunning(run, [])

  // Wire domain events → WebSocket
  const boundSaveTrace = (rId: string, entry: Record<string, unknown>) => saveTrace(ctx.activeRuns, rId, entry)
  wireEventBroadcasting(services, runId, run, boundSaveTrace, createNotification)

  await services.runRepo.save(run)
  await services.eventBus.publish(runStarted(run.id, "agent-session"))
  await services.auditService.log({ actor, action: "agent.started", resourceType: "AgentRun", resourceId: run.id, detail: { goal, tools: tools.map((t) => t.name), agentId, workspaceMode: runWorkspace.isolated ? "isolated" : "shared", workspaceRoot: runWorkspace.executionRoot } })

  persistRun(run, goal, agentId, resume?.parentRunId)

  const state: RunState = { run, actor, stepCounter: resume?.iteration ?? 0 }

  // Build workspace context helper (captures queueRef + workspace)
  const withCtx = <T>(workspaceRoot: string, fn: () => Promise<T>) =>
    withToolWorkspaceContext(ctx.toolContextQueueRef, ctx.workspace, workspaceRoot, fn)

  const trackedTools = tools.map((t) => wrapWithEffects(t, runId, runWorkspace.executionRoot, withCtx))
  const governedTools = trackedTools.map((t) => governTool(t, services, state, { signal: controller.signal }))

  const maxDelegationDepth = Number(process.env["DELEGATION_MAX_DEPTH"]) || 3
  const agentName = agentId ? (db.getAgentDefinition(agentId)?.name ?? "Agent") : "Universal Agent"
  const busTools = createBusTools(bus, runId, agentName)

  const delegateCtx: DelegateContext = {
    llm: ctx.llm,
    availableTools: governedTools,
    depth: 0,
    maxDepth: maxDelegationDepth,
    signal: controller.signal,
    extraChildTools: busTools,
    acquireSlot: (childRunId: string) => ctx.queue.acquire(childRunId, "high", controller.signal),
    resolveAgent: (aId: string): ResolvedAgent | null => {
      const def = db.getAgentDefinition(aId)
      if (!def) return null
      const agentTools = resolveTools(JSON.parse(def.tools) as string[]).map((t) => governTool(t, services, state, { signal: controller.signal }))
      return { id: def.id, name: def.name, systemPrompt: def.system_prompt, tools: agentTools }
    },
    onChildTrace: (entry) => {
      boundSaveTrace(runId, entry)
      if (entry.kind === "delegation-start") {
        broadcast({ type: "delegation.started", data: { runId, ...entry } })
        services.auditService.log({ actor: "agent", action: "delegation.started", resourceType: "AgentRun", resourceId: runId, detail: { goal: entry.goal, depth: entry.depth, tools: entry.tools, agentName: entry.agentName } }).catch(() => {})
      } else if (entry.kind === "delegation-end") {
        broadcast({ type: "delegation.ended", data: { runId, ...entry } })
        services.auditService.log({ actor: "agent", action: entry.status === "done" ? "delegation.completed" : "delegation.failed", resourceType: "AgentRun", resourceId: runId, detail: { depth: entry.depth, status: entry.status, answer: entry.answer, error: entry.error } }).catch(() => {})
      } else if (entry.kind === "delegation-iteration") {
        broadcast({ type: "delegation.iteration", data: { runId, ...entry } })
      } else if (entry.kind === "delegation-parallel-start") {
        broadcast({ type: "delegation.parallel-started", data: { runId, ...entry } })
      } else if (entry.kind === "delegation-parallel-end") {
        broadcast({ type: "delegation.parallel-ended", data: { runId, ...entry } })
      } else if (entry.kind === "thinking") {
        broadcast({ type: "agent.thinking", data: { runId, content: entry.text } })
      } else if (typeof entry.kind === "string" && entry.kind.startsWith("planner-delegation")) {
        broadcast({ type: "debug.trace", data: { runId, seq: Date.now(), entry } })
      } else if (entry.kind === "llm-request" || entry.kind === "llm-response" || entry.kind === "nudge") {
        broadcast({ type: "debug.trace", data: { runId, seq: Date.now(), entry } })
      }
    },
    onChildUsage: (() => {
      const lastSeen = new WeakMap<object, { p: number; c: number; t: number; l: number }>()
      let totalPrompt = 0, totalCompletion = 0, totalTokens = 0, totalLlmCalls = 0
      return (childUsage: { promptTokens: number; completionTokens: number; totalTokens: number }, childLlmCalls: number) => {
        const prev = lastSeen.get(childUsage) ?? { p: 0, c: 0, t: 0, l: 0 }
        totalPrompt += childUsage.promptTokens - prev.p
        totalCompletion += childUsage.completionTokens - prev.c
        totalTokens += childUsage.totalTokens - prev.t
        totalLlmCalls += childLlmCalls - prev.l
        lastSeen.set(childUsage, { p: childUsage.promptTokens, c: childUsage.completionTokens, t: childUsage.totalTokens, l: childLlmCalls })
        agent.usage.promptTokens = totalPrompt
        agent.usage.completionTokens = totalCompletion
        agent.usage.totalTokens = totalTokens
        agent.llmCalls = totalLlmCalls
        broadcast({ type: "usage.updated", data: { runId, promptTokens: totalPrompt, completionTokens: totalCompletion, totalTokens, llmCalls: totalLlmCalls } })
      }
    })(),
  }
  const delegateTools = createDelegateTools(delegateCtx)

  const runAskUserTool: Tool = {
    ...askUserTool,
    execute: async (args) => {
      const question = String(args.question ?? "")
      if (!question) return "Error: 'question' is required"
      const options = Array.isArray(args.options) ? args.options.map(String) : undefined
      const sensitive = Boolean(args.sensitive)
      boundSaveTrace(runId, { kind: "user-input-request", question, options, sensitive })
      broadcast({ type: "user_input.required", data: { runId, question, options: options ?? [], sensitive } })
      const response = await new Promise<string>((resolve) => {
        ctx.pendingInputs.set(runId, { resolve })
      })
      return response
    },
  }

  const allTools = [...governedTools, ...delegateTools, ...busTools, runAskUserTool]
  resetEffectSeq(runId)

  // Build memory context
  const shouldUseMemory = !(runWorkspace.taskType === "code_generation" && !resume)
  const { perTier } = shouldUseMemory
    ? await retrieveContext(goal, { sessionId: agentId ?? "default", runId })
    : { perTier: { working: "", episodic: "", semantic: "" } }

  const systemMessages = await buildSystemMessages({ goal, systemPrompt, allTools, runWorkspace, perTier, runId })
  const effectivePrompt = systemMessages.map((m) => m.content).join("\n\n")

  // Pass the fully-resolved system prompt (includes DB knowledge, schema context, tool rules,
  // memory tiers) down to all child agents. Without this, children are completely "blind" —
  // they see only CHILD_SYSTEM_PROMPT and have no knowledge of the database or domain tools.
  delegateCtx.parentSystemPrompt = effectivePrompt

  const debugSeqRef = { value: 0 }
  const systemPromptEntry = { kind: "system-prompt" as const, text: effectivePrompt ?? "(no system prompt)" }
  boundSaveTrace(runId, systemPromptEntry)
  broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry: systemPromptEntry } })

  const toolsResolvedEntry = { kind: "tools-resolved" as const, tools: allTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }
  boundSaveTrace(runId, toolsResolvedEntry)
  broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry: toolsResolvedEntry } })

  let prevTotalTokens = 0

  const killManager: ToolKillManager = {
    register: (toolCallId: string, toolName: string) => {
      const perToolCtrl = new AbortController()
      const composed = AbortSignal.any([controller.signal, perToolCtrl.signal])
      setShellSignal(composed)
      setFetchKillSignal(composed)
      setBrowseKillSignal(composed)
      setMssqlKillSignal(composed)
      return new Promise<string>((resolve) => {
        const key = `${runId}:${toolCallId}`
        ctx.pendingKills.set(key, { resolve, perToolCtrl })
        broadcast({ type: "tool_call.executing", data: { runId, toolCallId, toolName } })
      })
    },
    unregister: (toolCallId: string) => {
      ctx.pendingKills.delete(`${runId}:${toolCallId}`)
      setShellSignal(controller.signal)
      setFetchKillSignal(null)
      setBrowseKillSignal(null)
      setMssqlKillSignal(null)
      broadcast({ type: "tool_call.completed", data: { runId, toolCallId } })
    },
  }

  // eslint-disable-next-line prefer-const
  let agent!: Agent
  agent = new Agent(ctx.llm, allTools, {
    verbose: true,
    signal: controller.signal,
    systemMessages,
    toolKillManager: killManager,
    enablePlanner: true,
    workspaceRoot: runWorkspace.executionRoot,
    onPlannerTrace: (entry) => handlePlannerTrace(entry, { runId, services, debugSeqRef, saveTrace: boundSaveTrace }),
    plannerDelegateFn: (step, envelope) => spawnChildForPlan(delegateCtx, step, envelope),
    onNudge: (data) => {
      const entry = { kind: "nudge" as const, tag: data.tag, message: data.message, iteration: data.iteration }
      boundSaveTrace(runId, entry)
      broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry } })
    },
    onLlmCall: (data) => {
      if (data.phase === "request") {
        const entry = { kind: "llm-request" as const, iteration: data.iteration, messageCount: data.messages.length, toolCount: data.tools.length, messages: data.messages.map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls?.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) ?? [], toolCallId: m.toolCallId ?? null })) }
        boundSaveTrace(runId, entry)
        broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry } })
      } else {
        const entry = { kind: "llm-response" as const, iteration: data.iteration, durationMs: data.durationMs, content: data.response.content, toolCalls: data.response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })), usage: data.response.usage ?? null }
        boundSaveTrace(runId, entry)
        broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry } })
      }
    },
    onThinking: (content, _toolCalls, iteration) => {
      const iterEntry = { kind: "iteration" as const, current: iteration + 1, max: 30 }
      boundSaveTrace(runId, iterEntry)
      broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry: iterEntry } })
      if (content) {
        boundSaveTrace(runId, { kind: "thinking", text: content })
        broadcast({ type: "agent.thinking", data: { runId, content, iteration } })
      }
      const iterationTokens = agent.usage.totalTokens - prevTotalTokens
      prevTotalTokens = agent.usage.totalTokens
      const usageEntry = { kind: "usage" as const, iterationTokens, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls }
      boundSaveTrace(runId, usageEntry)
      broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry: usageEntry } })
      broadcast({ type: "usage.updated", data: { runId, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, totalTokens: agent.usage.totalTokens, llmCalls: agent.llmCalls } })
    },
    onStep: (messages, iteration) => {
      lastMessages = messages
      lastIteration = iteration
      db.saveCheckpoint({ run_id: runId, messages: JSON.stringify(messages), iteration, step_counter: state.stepCounter, updated_at: new Date().toISOString() })
      broadcast({ type: "checkpoint.saved", data: { runId, iteration, stepCounter: state.stepCounter } })
      persistRun(run, goal, agentId, resume?.parentRunId)
    },
  })

  try {
    setShellSignal(controller.signal)
    setFetchKillSignal(null)
    setBrowseKillSignal(null)
    setMssqlKillSignal(null)
    const answer = await agent.run(goal, resume ? { messages: resume.messages, iteration: resume.iteration } : undefined)

    if (controller.signal.aborted) {
      cancelRun(run)
      await captureRunWorkspaceDiff(runId, ctx.activeRuns, ctx.completedRunWorkspaces, ctx.completedRunDiffs, boundSaveTrace, createNotification)
      await services.auditService.log({ actor, action: "agent.cancelled", resourceType: "AgentRun", resourceId: run.id, detail: { goal, totalTokens: agent.usage.totalTokens, llmCalls: agent.llmCalls } })
      persistRun(run, goal, agentId, resume?.parentRunId)
      await persistAuditLog(services, runId)
      persistTokenUsage(runId, agent)
      broadcast({ type: "run.cancelled", data: { runId, status: "cancelled", stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })
      createNotification({ type: "run.cancelled", title: "Run cancelled", message: `"${goal.slice(0, 80)}" was cancelled after ${run.steps.length} steps.`, runId, actions: [{ label: "View", action: "view-run", data: { runId } }, { label: "Rollback", action: "rollback-run", data: { runId } }] })
      return
    }

    completeRun(run)
    await services.eventBus.publish(runCompleted(run.id))
    await services.auditService.log({ actor, action: "agent.completed", resourceType: "AgentRun", resourceId: run.id, detail: { goal, answer: answer.slice(0, 500), totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })

    persistRun(run, goal, agentId, resume?.parentRunId, answer)
    await persistAuditLog(services, runId)
    persistTokenUsage(runId, agent)

    boundSaveTrace(runId, { kind: "answer", text: answer })
    await captureRunWorkspaceDiff(runId, ctx.activeRuns, ctx.completedRunWorkspaces, ctx.completedRunDiffs, boundSaveTrace, createNotification)
    const pendingDiff = ctx.completedRunDiffs.get(runId)
    const pendingChangeCount = pendingDiff ? pendingDiff.added.length + pendingDiff.modified.length + pendingDiff.deleted.length : 0

    ingestRunTurns({ id: runId, goal, answer, status: "completed", agentId, tools: [...new Set(run.steps.map((s) => s.action))], stepCount: run.steps.length, trace: run.steps.map((s) => ({ kind: "tool-call" as const, tool: s.action, text: `${s.action}(${Object.keys(s.input).join(", ")})`, argsSummary: Object.keys(s.input).join(", ") })) })
    extractProcedural({ id: runId, goal, trace: run.steps.map((s) => ({ kind: "tool-call" as const, tool: s.action, text: `${s.action}(${Object.keys(s.input).join(", ")})`, argsSummary: Object.keys(s.input).join(", ") })) })
    consolidate({ minAgeHours: 24 })

    broadcast({ type: "run.completed", data: { runId, answer, status: "completed", stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls, pendingWorkspaceChanges: pendingChangeCount } })
    createNotification({ type: "run.completed", title: "Run completed", message: pendingChangeCount > 0 ? `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps. ${pendingChangeCount} workspace changes pending approval.` : `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps.`, runId, actions: [{ label: "View", action: "view-run", data: { runId } }] })

    if (ctx.messageRouter) {
      ctx.messageRouter.sendReply(runId, answer).catch((err) => { console.error(`Failed to send reply for run ${runId}:`, err) })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    failRun(run)
    await services.eventBus.publish(runFailed(run.id, errMsg))
    await services.auditService.log({ actor, action: "agent.failed", resourceType: "AgentRun", resourceId: run.id, detail: { goal, error: errMsg, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })

    if (lastMessages.length > 0) {
      db.saveCheckpoint({ run_id: runId, messages: JSON.stringify(lastMessages), iteration: lastIteration, step_counter: state.stepCounter, updated_at: new Date().toISOString() })
      broadcast({ type: "checkpoint.saved", data: { runId, iteration: lastIteration, stepCounter: state.stepCounter } })
    }

    persistRun(run, goal, agentId, resume?.parentRunId, undefined, errMsg)
    await persistAuditLog(services, runId)
    persistTokenUsage(runId, agent)

    boundSaveTrace(runId, { kind: "error", text: errMsg })
    await captureRunWorkspaceDiff(runId, ctx.activeRuns, ctx.completedRunWorkspaces, ctx.completedRunDiffs, boundSaveTrace, createNotification)

    ingestRunTurns({ id: runId, goal, answer: null, status: "failed", agentId, tools: [...new Set(run.steps.map((s) => s.action))], stepCount: run.steps.length, error: errMsg, trace: run.steps.map((s) => ({ kind: "tool-call" as const, tool: s.action, text: `${s.action}(${Object.keys(s.input).join(", ")})`, argsSummary: Object.keys(s.input).join(", ") })) })

    broadcast({ type: "run.failed", data: { runId, error: errMsg, stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })
    const hasCheckpoint = !!db.getCheckpoint(runId)
    createNotification({ type: "run.failed", title: "Run failed", message: `"${goal.slice(0, 80)}" failed: ${errMsg.slice(0, 120)}`, runId, actions: [{ label: "Review", action: "view-run", data: { runId } }, ...(hasCheckpoint ? [{ label: "Resume", action: "resume-run", data: { runId } }] : []), { label: "Rollback", action: "rollback-run", data: { runId } }] })
  } finally {
    setShellSignal(null)
    setFetchKillSignal(null)
    setBrowseKillSignal(null)
    setMssqlKillSignal(null)
    releaseSlot()
    bus.dispose()
    ctx.pendingInputs.delete(runId)
    ctx.activeRuns.delete(runId)
  }
}
