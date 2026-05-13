import {
    Agent,
    AgentRuntime,
    askUserTool,
    cancelRun,
    completeRun,
    createDelegateTools,
    createRun,
    detectInternalFailure,
    failRun,
    fillRunReference,
    governTool,
    isPlatformUnconfiguredAnswer,
    isUserSafeFailureAnswer,
    mapFailureKindForPolish,
    markPolishedFailure,
    polishFailureForUser,
    runCompleted,
    runFailed,
    runStarted,
    runWithMssqlKillSignal,
    runWithPolicyContext,
    spawnChildForPlan,
    startPlanning,
    startRunning,
    synthesizeGenericFailureAnswer,
    type DelegateContext,
    type EngineServices,
    type HostedPolicyContext,
    type Message,
    type ResolvedAgent,
    type RunState,
    type Tool,
    type ToolKillManager
} from "@agent001/agent"
import { AgentBus, createBusTools } from "../agent-bus.js"
import * as db from "../db.js"
import { resetEffectSeq } from "../effects.js"
import { broadcast } from "../event-broadcaster.js"
import { consolidate, extractProcedural, ingestRunTurns, retrieveContext } from "../memory.js"
import type { RunPriority } from "../queue.js"
import { prepareRunWorkspace } from "../run-workspace.js"
import { getAllTools } from "../tools.js"
import { wireEventBroadcasting } from "./event-wiring.js"
import { createNotification, persistAuditLog, persistRun, persistTokenUsage, saveTrace } from "./persistence.js"
import { handlePlannerTrace } from "./planner-events.js"
import { buildSystemMessages } from "./system-messages.js"
import type { OrchestratorRunCtx } from "./types.js"
import { captureRunWorkspaceDiff, wrapWithEffects } from "./workspace-effects.js"

const MSSQL_TOOL_TIMEOUT_MS = 120_000

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

  // Wire domain events → SEE
  const boundSaveTrace = (rId: string, entry: Record<string, unknown>) => saveTrace(ctx.activeRuns, rId, entry)
  wireEventBroadcasting(services, runId, run, boundSaveTrace, createNotification)

  await services.runRepo.save(run)
  await services.eventBus.publish(runStarted(run.id, "agent-session"))
  await services.auditService.log({ actor, action: "agent.started", resourceType: "AgentRun", resourceId: run.id, detail: { goal, tools: tools.map((t) => t.name), agentId, profile: runWorkspace.profile, workspaceMode: runWorkspace.isolated ? "isolated" : "shared", workspaceRoot: runWorkspace.executionRoot } })

  persistRun(run, goal, agentId, resume?.parentRunId)

  const state: RunState = { run, actor, stepCounter: resume?.iteration ?? 0 }

  // Per-request AgentRuntime — owns this run's workspace cwd, kill signals,
  // browse-web sessions, and ask-user resolver. Inherits shared infra (mssql
  // pools, executors, catalog cache, sync sinks) from the process root.
  const runtime = new AgentRuntime({
    workspaceRoot: runWorkspace.executionRoot,
    signal: controller.signal,
  })
  runtime.shell.cwd = runWorkspace.executionRoot
  runtime.browserCheck.cwd = runWorkspace.executionRoot
  runtime.filesystem.basePath = runWorkspace.executionRoot
  runtime.searchFiles.basePath = runWorkspace.executionRoot

  const governRuntimeTool = (tool: Tool) => governTool(tool, services, state, {
    signal: controller.signal,
    ...((tool.name === "query_mssql" || tool.name === "explore_mssql_schema") ? { timeoutMs: MSSQL_TOOL_TIMEOUT_MS } : {}),
  })

  const trackedTools = tools.map((t) => wrapWithEffects(t, runId, runWorkspace.executionRoot))
  const governedTools = trackedTools.map(governRuntimeTool)

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
      const agentTools = getAllTools().map(governRuntimeTool)
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

  // ask_user needs full step tracking (shows in Tool Timeline) but no timeout —
  // it blocks until the user responds, so timeoutMs: 0 disables the timeout racer.
  const governedAskUser = governTool(runAskUserTool, services, state, { signal: controller.signal, timeoutMs: 0 })
  const allToolsBase = [...governedTools, ...delegateTools, ...busTools, governedAskUser]

  // Wrap sync tools to emit global SSE events so the Sync widget can react
  // to agent-triggered previews and executes without needing to go through
  // the HTTP route.
  const allTools = allToolsBase.map((t) => {
    if (t.name === "sync_preview") {
      return {
        ...t,
        execute: async (args: Record<string, unknown>) => {
          const result = await t.execute(args)
          if (typeof result === "string") {
            const m = result.match(/^Plan\s+([a-f0-9-]{36})\b/)
            if (m) {
              const planId = m[1]
              // Record in sync_runs so this preview appears in history.
              // Intentionally avoid loadPlan() here — the plan-store Map lives
              // in the agent package module scope; importing it here can resolve
              // to a different instance (ESM singleton issue), causing loadPlan
              // to return null and silently skip the write. Use args instead.
              const totalsMatch = result.match(/Totals:\s*\+(\d+)\s*~(\d+)\s*-(\d+)\s*\(=(\d+)\s*unchanged\)\s*across\s*(\d+)/)
              const previewTotals = totalsMatch
                ? { insert: Number(totalsMatch[1]), update: Number(totalsMatch[2]), delete: Number(totalsMatch[3]), unchanged: Number(totalsMatch[4]), tablesCount: Number(totalsMatch[5]) }
                : {}
              try {
                db.recordSyncRunStart({
                  planId,
                  entityType: String(args["entityType"] ?? ""),
                  entityId: String(args["entityId"] ?? ""),
                  entityDisplayName: null,   // not available without loadPlan; executeSync sink will fill it
                  source: String(args["source"] ?? ""),
                  target: String(args["target"] ?? ""),
                  actorUpn: "agent",
                  previewTotals,
                })
              } catch (e) {
                console.warn("[sync-history] recordSyncRunStart failed:", e instanceof Error ? e.message : e)
              }
              broadcast({
                type: "sync.agent.preview",
                data: {
                  runId,
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
    if (t.name === "sync_execute") {
      return {
        ...t,
        execute: async (args: Record<string, unknown>) => {
          const planId = String(args["planId"] ?? "")
          broadcast({ type: "sync.agent.execute.started", data: { runId, planId } })
          const t0 = Date.now()
          const result = await t.execute(args)
          const success = typeof result === "string" && result.toLowerCase().includes("successfully")
          // Also persist finish via db directly, in case executeSync threw before
          // calling getSyncRunSink().finish() internally. INSERT OR REPLACE means
          // if the row already has the correct status from the sink, this is a no-op.
          try {
            db.recordSyncRunFinish({
              planId,
              status: success ? "success" : "failed",
              error: success ? null : (typeof result === "string" ? result : null),
              durationMs: Date.now() - t0,
            })
          } catch (e) {
            console.warn("[sync-history] recordSyncRunFinish failed:", e instanceof Error ? e.message : e)
          }
          broadcast({
            type: "sync.agent.execute.completed",
            data: { runId, planId, success, result: typeof result === "string" ? result : String(result) },
          })
          return result
        },
      }
    }
    return t
  })
  resetEffectSeq(runId)

  // Build memory context
  const shouldUseMemory = !(runWorkspace.taskType === "code_generation" && !resume)
  let perTier: { working: string; episodic: string; semantic: string } = { working: "", episodic: "", semantic: "" }
  if (shouldUseMemory) {
    try {
      const result = await retrieveContext(goal, { sessionId: agentId ?? "default", runId })
      perTier = result.perTier
    } catch (memErr) {
      // FTS virtual-table corruption (SQLITE_CORRUPT_VTAB) or other memory errors
      // must not crash the run — continue without injected context.
      console.warn(`[run ${runId}] memory retrieval failed, running without context:`, (memErr as Error).message)
    }
  }

  const systemMessages = await buildSystemMessages({
    goal, systemPrompt, allTools, runWorkspace, perTier, runId,
    attachmentIds: activeRun?.attachmentIds ?? [],
  })
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

  const killManager: ToolKillManager = (() => {
    // Per-tool-call composed signal map. wrap() reads from here to install
    // an ALS scope around tool.execute(), so concurrent runs each see their
    // own mssql kill signal (no last-writer-wins module global).
    const callSignals = new Map<string, AbortSignal>()
    return {
      register: (toolCallId: string, toolName: string) => {
        const perToolCtrl = new AbortController()
        const composed = AbortSignal.any([controller.signal, perToolCtrl.signal])
        callSignals.set(toolCallId, composed)
        // Tool-call kill signals live on the per-request runtime. shell/fetch
        // /browse-web tools read these via currentRuntime() inside agent.run().
        runtime.shell.killSignal = composed
        runtime.fetchUrl.killSignal = composed
        runtime.browseWeb.killSignal = composed
        return new Promise<string>((resolve) => {
          const key = `${runId}:${toolCallId}`
          ctx.pendingKills.set(key, { resolve, perToolCtrl })
          broadcast({ type: "tool_call.executing", data: { runId, toolCallId, toolName } })
        })
      },
      unregister: (toolCallId: string) => {
        callSignals.delete(toolCallId)
        ctx.pendingKills.delete(`${runId}:${toolCallId}`)
        runtime.shell.killSignal = controller.signal
        runtime.fetchUrl.killSignal = null
        runtime.browseWeb.killSignal = null
        broadcast({ type: "tool_call.completed", data: { runId, toolCallId } })
      },
      wrap: <T,>(toolCallId: string, fn: () => Promise<T>): Promise<T> => {
        const sig = callSignals.get(toolCallId)
        if (!sig) return fn()
        return runWithMssqlKillSignal(sig, fn) as Promise<T>
      },
    }
  })()

  // eslint-disable-next-line prefer-const
  let agent!: Agent
  agent = new Agent(ctx.llm, allTools, {
    verbose: true,
    signal: controller.signal,
    systemMessages,
    toolKillManager: killManager,
    enablePlanner: true,
    workspaceRoot: runWorkspace.executionRoot,
    runtime,
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
    onToken: (token) => {
      broadcast({ type: "answer.chunk", data: { runId, chunk: token } })
    },
    onStreamDiscard: () => {
      broadcast({ type: "stream.reset", data: { runId } })
    },
  })

  try {
    runtime.shell.killSignal = controller.signal
    runtime.fetchUrl.killSignal = null
    runtime.browseWeb.killSignal = null

    // Hosted policy context — read by the selector-based policy engine
    // through AsyncLocalStorage. Concurrent runs see independent contexts.
    // The role is captured at startRun/resumeRun (see orchestrator.ts) and
    // stashed on ActiveRun because the originating session ALS is no longer
    // in scope by the time queued work resumes.
    const policyCtx: HostedPolicyContext = {
      runId,
      runMode:     runWorkspace.profile === "hosted" ? "hosted" : "developer",
      role:        activeRun?.role ?? "admin",
      sandboxRoot: runWorkspace.executionRoot,
    }

    let answer = await runWithPolicyContext(policyCtx, () =>
      agent.run(goal, resume ? { messages: resume.messages, iteration: resume.iteration } : undefined),
    )

    // Fill the {RUN_REF} placeholder in opaque platform-unconfigured answers
    // so the user has a concrete reference to forward to the platform admin.
    // The actual technical detail (env var, missing service) is logged
    // separately via the planner-platform-unconfigured trace handler — never
    // shown to the end user. We also try to LLM-polish into a friendlier
    // reply; canned message is the safety net.
    if (isPlatformUnconfiguredAnswer(answer)) {
      const polished = await polishFailureForUser(ctx.llm, {
        goal,
        operatorSummary: "A required backend integration is not configured on this server.",
        failureKind: "platform_unconfigured",
        runRef: runId,
      }, { signal: controller.signal })
      answer = polished
        ? markPolishedFailure(polished)
        : fillRunReference(answer, runId)
    }

    // Catch internal failures the agent surfaced as raw text/JSON
    // (planner_failure JSON dump, "Task FAILED" / "Task verification FAILED"
    // walls). The chat user must see a short, friendly natural-language
    // reply (LLM-polished from the operator-only failure context) plus a
    // run reference; the raw detail goes to db logs + audit so admins can
    // debug. If the LLM polish fails or looks like it leaked technical
    // detail, we fall back to the canned synthesizeGenericFailureAnswer().
    const internalFailure = detectInternalFailure(answer)
    if (internalFailure) {
      const truncatedRaw = internalFailure.rawDetail.slice(0, 4000)
      try {
        db.saveLog({
          run_id: runId,
          level: "run:error",
          message: `[user-safe-failure] ${internalFailure.kind} — ${internalFailure.summary}\n${truncatedRaw}`,
          timestamp: new Date().toISOString(),
        })
      } catch { /* don't break run on log failure */ }
      try {
        await services.auditService.log({
          actor,
          action: "agent.user_safe_failure",
          resourceType: "AgentRun",
          resourceId: runId,
          detail: { kind: internalFailure.kind, summary: internalFailure.summary, raw: truncatedRaw },
        })
      } catch { /* best-effort */ }
      try {
        broadcast({ type: "run.user_safe_failure", data: { runId, kind: internalFailure.kind, summary: internalFailure.summary } })
      } catch { /* best-effort */ }
      console.error(`[run-executor] Internal failure for run ${runId} (${internalFailure.kind}): ${internalFailure.summary}`)

      const polished = await polishFailureForUser(ctx.llm, {
        goal,
        operatorSummary: internalFailure.summary,
        failureKind: mapFailureKindForPolish(internalFailure.kind),
        runRef: runId,
      }, { signal: controller.signal })

      answer = polished
        ? markPolishedFailure(polished)
        : fillRunReference(synthesizeGenericFailureAnswer(), runId)
    }

    if (controller.signal.aborted) {
      cancelRun(run)
      await captureRunWorkspaceDiff(runId, ctx.activeRuns, ctx.completedRunWorkspaces, ctx.completedRunDiffs, boundSaveTrace, createNotification)
      await services.auditService.log({ actor, action: "agent.cancelled", resourceType: "AgentRun", resourceId: run.id, detail: { goal, totalTokens: agent.usage.totalTokens, llmCalls: agent.llmCalls } })
      persistRun(run, goal, agentId, resume?.parentRunId)
      await persistAuditLog(services, runId)
      persistTokenUsage(runId, agent)
      broadcast({ type: "run.cancelled", data: { runId, status: "cancelled", stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })
      db.saveLog({ run_id: runId, level: "run:error", message: "Cancelled", timestamp: new Date().toISOString() })
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
    const persistedToolTrace = run.steps.map((step) => {
      const input = step.input ?? {}
      const keys = Object.keys(input)
      // UI clips long values with CSS ellipsis; keep the full string here.
      const argsSummary = keys.length > 0
        ? keys.length === 1 ? `${keys[0]}=${JSON.stringify(input[keys[0]])}` : `${keys.length} args`
        : ""
      return {
        kind: "tool-call" as const,
        tool: step.action,
        text: `${step.action}(${argsSummary || "..."})`,
        argsSummary,
        argsFormatted: JSON.stringify(input, null, 2),
      }
    })

    // A run can return an answer that starts with "Task FAILED" or
    // "Task verification FAILED" when the planner internally synthesizes a
    // failure (all steps incomplete, unresolved blockers, etc.). It can
    // also return a platform-unconfigured opaque message when an operator-
    // owned integration is missing. The orchestrator sees no exception, so
    // the run "completed" at the infrastructure level — but episodic memory
    // must record it as failed so it is NOT used as positive evidence by
    // the ⚠️ MEMORY HIT directive in future runs.
    const taskInternallyFailed =
      answer.startsWith("Task FAILED")
      || answer.startsWith("Task verification FAILED")
      || isUserSafeFailureAnswer(answer)
    ingestRunTurns({ id: runId, goal, answer: taskInternallyFailed ? null : answer, status: taskInternallyFailed ? "failed" : "completed", agentId, tools: [...new Set(run.steps.map((s) => s.action))], stepCount: run.steps.length, error: taskInternallyFailed ? answer.slice(0, 200) : undefined, trace: persistedToolTrace })
    extractProcedural({ id: runId, goal, trace: persistedToolTrace })
    consolidate({ minAgeHours: 24 })

    broadcast({ type: "run.completed", data: { runId, answer, status: "completed", stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls, pendingWorkspaceChanges: pendingChangeCount } })
    db.saveLog({ run_id: runId, level: "run", message: `Completed — ${run.steps.length} steps`, timestamp: new Date().toISOString() })
    createNotification({ type: "run.completed", title: "Run completed", message: pendingChangeCount > 0 ? `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps. ${pendingChangeCount} workspace changes pending approval.` : `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps.`, runId, actions: [{ label: "View", action: "view-run", data: { runId } }] })

    if (ctx.messageRouter) {
      ctx.messageRouter.sendReply(runId, answer).catch((err) => { console.error(`Failed to send reply for run ${runId}:`, err) })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const persistedToolTrace = run.steps.map((step) => {
      const input = step.input ?? {}
      const keys = Object.keys(input)
      // UI clips long values with CSS ellipsis; keep the full string here.
      const argsSummary = keys.length > 0
        ? keys.length === 1 ? `${keys[0]}=${JSON.stringify(input[keys[0]])}` : `${keys.length} args`
        : ""
      return {
        kind: "tool-call" as const,
        tool: step.action,
        text: `${step.action}(${argsSummary || "..."})`,
        argsSummary,
        argsFormatted: JSON.stringify(input, null, 2),
      }
    })
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

    ingestRunTurns({ id: runId, goal, answer: null, status: "failed", agentId, tools: [...new Set(run.steps.map((s) => s.action))], stepCount: run.steps.length, error: errMsg, trace: persistedToolTrace })

    broadcast({ type: "run.failed", data: { runId, error: errMsg, stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })
    db.saveLog({ run_id: runId, level: "run:error", message: `Failed — ${errMsg.slice(0, 200)}`, timestamp: new Date().toISOString() })
    const hasCheckpoint = !!db.getCheckpoint(runId)
    createNotification({ type: "run.failed", title: "Run failed", message: `"${goal.slice(0, 80)}" failed: ${errMsg.slice(0, 120)}`, runId, actions: [{ label: "Review", action: "view-run", data: { runId } }, ...(hasCheckpoint ? [{ label: "Resume", action: "resume-run", data: { runId } }] : []), { label: "Rollback", action: "rollback-run", data: { runId } }] })
  } finally {
    await runtime.dispose()
    releaseSlot()
    bus.dispose()
    ctx.pendingInputs.delete(runId)
    ctx.activeRuns.delete(runId)
  }
}
