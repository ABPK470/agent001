/**
 * Agent orchestrator — manages agent runs with full lifecycle.
 *
 * Handles:
 *   - Starting governed agent runs (with audit, policies, tracking)
 *   - Real-time event broadcasting to WebSocket clients
 *   - Checkpointing after each tool call (for resume)
 *   - Resuming failed runs from checkpoint
 *   - Cancelling running agents
 *   - Persisting everything to SQLite
 */

import {
    Agent,
    askUserTool,
    cancelRun,
    completeRun,
    createDelegateTools,
    createEngineServices,
    createRun,
    failRun,
    governTool,
    PolicyEffect,
    runCompleted,
    runFailed,
    runStarted,
    setBasePath,
    setBrowserCheckCwd,
    setSearchBasePath,
    setShellCwd,
    setShellSignal,
    spawnChildForPlan,
    startPlanning,
    startRunning,
    type DelegateContext,
    type DomainEvent,
    type EngineServices,
    type LLMClient,
    type Message,
    type ResolvedAgent,
    type RunState,
    type Tool,
    type ToolKillManager,
} from "@agent001/agent"
import { randomUUID } from "node:crypto"
import { AgentBus, createBusTools } from "./agent-bus.js"
import type { MessageRouter } from "./channels/router.js"
import * as db from "./db.js"
import { migrateEffects, recordEffect, recordFileWrite, resetEffectSeq } from "./effects.js"
import { consolidate, extractProcedural, ingestRunTurns, migrateMemory, retrieveContext } from "./memory.js"
import { buildEnvironmentContext, buildToolContext, getWorkspaceContext } from "./prompt-builder.js"
import { RunQueue, type RunPriority } from "./queue.js"
import {
    applyWorkspaceDiff,
    cleanupRunWorkspace,
    cleanupStaleRunWorkspaces,
    computeWorkspaceDiff,
    prepareRunWorkspace,
    type RunWorkspaceContext,
    type WorkspaceDiff,
} from "./run-workspace.js"
import { getAllTools, resolveTools } from "./tools.js"
import { broadcast } from "./ws.js"

// ── Types ────────────────────────────────────────────────────────

interface ActiveRun {
  id: string
  goal: string
  agentId: string | null
  controller: AbortController
  services: EngineServices
  traceSeq: number
  /** Agent message bus for inter-agent communication within this run tree. */
  bus: AgentBus
  /** Workspace context (may be isolated per-run). */
  workspace: RunWorkspaceContext | null
}

/** Per-run agent configuration — which tools and prompt to use. */
export interface AgentRunConfig {
  agentId?: string
  tools?: Tool[]
  systemPrompt?: string
}

export interface OrchestratorConfig {
  llm: LLMClient
  messageRouter?: MessageRouter
  workspace?: string
}

// ── Orchestrator ─────────────────────────────────────────────────

export class AgentOrchestrator {
  private llm: LLMClient
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly pendingInputs = new Map<string, { resolve: (answer: string) => void }>()
  private readonly pendingKills = new Map<string, { resolve: (message: string) => void }>()
  private readonly queue: RunQueue
  private messageRouter: MessageRouter | null = null
  private workspace: string | null = null
  private readonly completedRunWorkspaces = new Map<string, RunWorkspaceContext>()
  private readonly completedRunDiffs = new Map<string, WorkspaceDiff>()
  private toolContextQueue: Promise<void> = Promise.resolve()

  constructor(config: OrchestratorConfig) {
    this.llm = config.llm
    this.messageRouter = config.messageRouter ?? null
    this.workspace = config.workspace ?? null
    this.queue = new RunQueue()

    // Migrate memory + effects tables on startup
    migrateMemory()
    migrateEffects()

    // Best-effort cleanup for old isolated run sandboxes (e.g. after restarts).
    const ttlMs = Number(process.env["AGENT_RUN_WORKSPACE_TTL_MS"] ?? 6 * 60 * 60 * 1000)
    if (Number.isFinite(ttlMs) && ttlMs >= 0) {
      void cleanupStaleRunWorkspaces(ttlMs)
    }
  }

  /** Update the workspace path (used in system prompt context). */
  setWorkspace(path: string): void {
    this.workspace = path
  }

  /** Hot-swap the LLM client — takes effect on the next run. */
  setLlm(client: LLMClient): void {
    this.llm = client
  }

  /** Set the message router (for wiring after construction). */
  setMessageRouter(router: MessageRouter): void {
    this.messageRouter = router
  }

  /** Start a new governed agent run. Returns the run ID immediately. */
  startRun(goal: string, config?: AgentRunConfig): string {
    const runId = randomUUID()
    const controller = new AbortController()
    const services = createEngineServices()
    const agentId = config?.agentId ?? null

    // Resolve tools for this run (from config or default: all tools)
    const tools = config?.tools ?? getAllTools()

    // Load persisted policy rules into this run's evaluator
    const dbRules = db.listPolicyRules()
    for (const r of dbRules) {
      services.policyEvaluator.addRule({
        name: r.name,
        effect: r.effect as PolicyEffect,
        condition: r.condition,
        parameters: JSON.parse(r.parameters),
      })
    }

    // Create a message bus for this run tree (parent + all delegates share it)
    const bus = new AgentBus(runId)

    this.activeRuns.set(runId, { id: runId, goal, agentId, controller, services, traceSeq: 0, bus, workspace: null })

    broadcast({ type: "run.queued", data: { runId, goal, agentId, queueStats: this.queue.stats() } })
    this.saveTrace(runId, { kind: "goal", text: goal })

    this.executeRun(runId, goal, tools, config?.systemPrompt, agentId, services, controller, bus).catch((err) => {
      console.error(`Run ${runId} crashed:`, err)
    })

    return runId
  }

  /** Cancel a running agent. */
  cancelRun(runId: string): boolean {
    const active = this.activeRuns.get(runId)
    if (!active) {
      // Might still be in the queue
      const removed = this.queue.remove(runId)
      return removed
    }
    active.controller.abort()
    broadcast({ type: "run.cancelled", data: { runId } })
    return true
  }

  /** Resume a failed run from its last checkpoint. */
  resumeRun(runId: string): string | null {
    const checkpoint = db.getCheckpoint(runId)
    const originalRun = db.getRun(runId)
    if (!checkpoint || !originalRun) return null

    // Idempotency: prevent resuming a run that's already active or completed
    if (this.activeRuns.has(runId)) return null
    if (originalRun.status === "completed") return null

    // Idempotency: check if this run was already resumed (has a child run)
    const existingRuns = db.listRuns(200)
    const alreadyResumed = existingRuns.find(
      (r) => r.parent_run_id === runId && (r.status === "running" || r.status === "pending" || r.status === "planning"),
    )
    if (alreadyResumed) return alreadyResumed.id // Return existing child instead of creating duplicate

    const newRunId = randomUUID()
    const controller = new AbortController()
    const services = createEngineServices()
    const bus = new AgentBus(newRunId)

    this.activeRuns.set(newRunId, {
      id: newRunId,
      goal: originalRun.goal,
      agentId: originalRun.agent_id ?? null,
      controller,
      services,
      traceSeq: 0,
      bus,
      workspace: null,
    })

    broadcast({
      type: "run.queued",
      data: { runId: newRunId, goal: originalRun.goal, resumedFrom: runId },
    })
    this.saveTrace(newRunId, { kind: "goal", text: originalRun.goal })

    const messages = JSON.parse(checkpoint.messages) as Message[]
    const iteration = checkpoint.iteration

    // Resolve tools from agent definition if original run had one
    let tools = getAllTools()
    let systemPrompt: string | undefined
    if (originalRun.agent_id) {
      const agentDef = db.getAgentDefinition(originalRun.agent_id)
      if (agentDef) {
        tools = resolveTools(JSON.parse(agentDef.tools) as string[])
        systemPrompt = agentDef.system_prompt
      }
    }

    this.executeRun(
      newRunId,
      originalRun.goal,
      tools,
      systemPrompt,
      originalRun.agent_id ?? null,
      services,
      controller,
      bus,
      { messages, iteration, parentRunId: runId },
    ).catch((err) => {
      console.error(`Resumed run ${newRunId} crashed:`, err)
    })

    return newRunId
  }

  /** Get IDs of currently running agents. */
  getActiveRunIds(): string[] {
    return [...this.activeRuns.keys()]
  }

  /** Get queue statistics. */
  getQueueStats() {
    return this.queue.stats()
  }

  /** Respond to a pending ask_user request. Returns true if a request was pending. */
  respondToRun(runId: string, response: string): boolean {
    const pending = this.pendingInputs.get(runId)
    if (!pending) return false
    pending.resolve(response)
    this.pendingInputs.delete(runId)

    this.saveTrace(runId, { kind: "user-input-response", text: response })
    broadcast({ type: "user_input.response", data: { runId } })
    return true
  }

  /** Kill a specific tool call and inject a user steering message. */
  killToolCall(runId: string, toolCallId: string, message: string): boolean {
    const key = `${runId}:${toolCallId}`
    const pending = this.pendingKills.get(key)
    if (!pending) return false
    pending.resolve(message)
    this.pendingKills.delete(key)
    broadcast({ type: "tool_call.killed", data: { runId, toolCallId, message } })
    return true
  }

  /**
   * Auto-recovery on startup — find runs that were "running" when the
   * server crashed, mark them as failed, and auto-resume from checkpoint.
   *
   * Returns the list of recovered run IDs (new runs that resumed).
   */
  recoverStaleRuns(): { recovered: string[], failed: string[] } {
    const staleRuns = db.findStaleRuns()
    const recovered: string[] = []
    const failed: string[] = []

    for (const stale of staleRuns) {
      // Skip runs that are currently active (shouldn't happen on fresh start)
      if (this.activeRuns.has(stale.id)) continue

      // Mark the stale run as failed
      db.markRunCrashed(stale.id)
      failed.push(stale.id)

      // Attempt to resume from checkpoint
      const checkpoint = db.getCheckpoint(stale.id)
      if (checkpoint) {
        const newRunId = this.resumeRun(stale.id)
        if (newRunId) {
          recovered.push(newRunId)

          // Create notification
          this.createNotification({
            type: "run.recovered",
            title: "Run auto-recovered",
            message: `"${stale.goal.slice(0, 80)}" was interrupted by a server restart and has been automatically resumed.`,
            runId: newRunId,
            actions: [
              { label: "View Run", action: "view-run", data: { runId: newRunId } },
            ],
          })
        } else {
          // Could not resume — notify user
          this.createNotification({
            type: "run.failed",
            title: "Run interrupted",
            message: `"${stale.goal.slice(0, 80)}" was interrupted by a server restart. Resume manually from checkpoint.`,
            runId: stale.id,
            actions: [
              { label: "Review", action: "view-run", data: { runId: stale.id } },
              { label: "Resume", action: "resume-run", data: { runId: stale.id } },
            ],
          })
        }
      } else {
        // No checkpoint — just notify
        this.createNotification({
          type: "run.failed",
          title: "Run lost",
          message: `"${stale.goal.slice(0, 80)}" was interrupted with no checkpoint available.`,
          runId: stale.id,
          actions: [
            { label: "Review", action: "view-run", data: { runId: stale.id } },
          ],
        })
      }
    }

    return { recovered, failed }
  }

  /**
   * Create a notification and broadcast it via WebSocket.
   */
  createNotification(opts: {
    type: string
    title: string
    message: string
    runId?: string | null
    stepId?: string | null
    actions?: Array<{ label: string; action: string; data?: Record<string, unknown> }>
  }): void {
    const notification: db.DbNotification = {
      id: randomUUID(),
      type: opts.type,
      title: opts.title,
      message: opts.message,
      run_id: opts.runId ?? null,
      step_id: opts.stepId ?? null,
      actions: JSON.stringify(opts.actions ?? []),
      read: 0,
      created_at: new Date().toISOString(),
    }

    db.saveNotification(notification)

    broadcast({
      type: "notification",
      data: {
        id: notification.id,
        notificationType: notification.type,
        title: notification.title,
        message: notification.message,
        runId: notification.run_id,
        stepId: notification.step_id,
        actions: opts.actions ?? [],
        read: false,
      },
    })
  }

  // ── Private: execute a governed agent run ────────────────────

  private async executeRun(
    runId: string,
    goal: string,
    tools: Tool[],
    systemPrompt: string | undefined,
    agentId: string | null,
    services: EngineServices,
    controller: AbortController,
    bus: AgentBus,
    resume?: { messages: Message[], iteration: number, parentRunId: string },
    priority: RunPriority = "normal",
  ): Promise<void> {
    // Acquire a queue slot (waits if at capacity)
    let releaseSlot: () => void
    try {
      releaseSlot = await this.queue.acquire(runId, priority, controller.signal)
    } catch {
      // Cancelled while queued — clean up and exit
      this.activeRuns.delete(runId)
      return
    }

    const actor = "user"
    let lastMessages: Message[] = []
    let lastIteration = 0
    const baseWorkspace = this.workspace ?? process.cwd()
    const runWorkspace = await prepareRunWorkspace({
      runId,
      sourceRoot: baseWorkspace,
      goal,
      resume: !!resume,
    })
    const activeRun = this.activeRuns.get(runId)
    if (activeRun) {
      activeRun.workspace = runWorkspace
    }

    // Create a tracked workflow run
    const run = createRun("agent-session", { goal })
    // Override the run ID so we can track it externally
    ;(run as { id: string }).id = runId
    startPlanning(run)
    startRunning(run, [])

    // Subscribe to domain events → broadcast to WS + save to DB
    this.wireEventBroadcasting(services, runId, run)

    await services.runRepo.save(run)
    await services.eventBus.publish(runStarted(run.id, "agent-session"))

    // Audit: agent started
    await services.auditService.log({
      actor,
      action: "agent.started",
      resourceType: "AgentRun",
      resourceId: run.id,
      detail: {
        goal,
        tools: tools.map((t) => t.name),
        agentId,
        workspaceMode: runWorkspace.isolated ? "isolated" : "shared",
        workspaceRoot: runWorkspace.executionRoot,
      },
    })

    // Save initial run to DB
    this.persistRun(run, goal, agentId, resume?.parentRunId)

    // Wrap tools with governance
    const state: RunState = {
      run,
      actor,
      stepCounter: resume?.iteration ?? 0,
    }

    // Wrap write_file with effect tracking (pre-write snapshots)
    const trackedTools = tools.map((t) => this.wrapWithEffects(t, runId, runWorkspace.executionRoot))
    const governedTools = trackedTools.map((t) => governTool(t, services, state, { signal: controller.signal }))

    // Create delegate tools for sub-agent spawning (sequential + parallel)
    const maxDelegationDepth = Number(process.env["DELEGATION_MAX_DEPTH"]) || 3
    const agentName = agentId
      ? (db.getAgentDefinition(agentId)?.name ?? "Agent")
      : "Universal Agent"

    // Create bus tools so the agent can communicate with siblings/children
    const busTools = createBusTools(bus, runId, agentName)

    const delegateCtx: DelegateContext = {
      llm: this.llm,
      availableTools: governedTools,
      depth: 0,
      maxDepth: maxDelegationDepth,
      signal: controller.signal,
      extraChildTools: busTools, // children get messaging tools
      acquireSlot: (childRunId: string) =>
        this.queue.acquire(childRunId, "high", controller.signal),
      resolveAgent: (agentId: string): ResolvedAgent | null => {
        const def = db.getAgentDefinition(agentId)
        if (!def) return null
        const toolNames = JSON.parse(def.tools) as string[]
        const agentTools = resolveTools(toolNames).map((t) => governTool(t, services, state, { signal: controller.signal }))
        return {
          id: def.id,
          name: def.name,
          systemPrompt: def.system_prompt,
          tools: agentTools,
        }
      },
      onChildTrace: (entry) => {
        this.saveTrace(runId, entry)
        // Broadcast delegation events in real-time + audit log
        if (entry.kind === "delegation-start") {
          broadcast({ type: "delegation.started", data: { runId, ...entry } })
          services.auditService.log({
            actor: "agent",
            action: "delegation.started",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: { goal: entry.goal, depth: entry.depth, tools: entry.tools, agentName: entry.agentName },
          }).catch(() => {})
        } else if (entry.kind === "delegation-end") {
          broadcast({ type: "delegation.ended", data: { runId, ...entry } })
          services.auditService.log({
            actor: "agent",
            action: entry.status === "done" ? "delegation.completed" : "delegation.failed",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: { depth: entry.depth, status: entry.status, answer: entry.answer, error: entry.error },
          }).catch(() => {})
        } else if (entry.kind === "delegation-iteration") {
          broadcast({ type: "delegation.iteration", data: { runId, ...entry } })
        } else if (entry.kind === "delegation-parallel-start") {
          broadcast({ type: "delegation.parallel-started", data: { runId, ...entry } })
        } else if (entry.kind === "delegation-parallel-end") {
          broadcast({ type: "delegation.parallel-ended", data: { runId, ...entry } })
        } else if (entry.kind === "thinking") {
          // Child agent thinking — forward to trace
          broadcast({ type: "agent.thinking", data: { runId, content: entry.text } })
        } else if (typeof entry.kind === "string" && entry.kind.startsWith("planner-delegation")) {
          // Planner delegation events (planner-delegation-start/iteration/end)
          broadcast({ type: "debug.trace", data: { runId, seq: Date.now(), entry } })
        } else if (entry.kind === "llm-request" || entry.kind === "llm-response" || entry.kind === "nudge") {
          // Child LLM call events and nudges — forward to trace for visibility
          broadcast({ type: "debug.trace", data: { runId, seq: Date.now(), entry } })
        }
      },
      onChildUsage: (() => {
        // Track cumulative usage across all child agents (planner + delegation).
        // Each child reports its own running total, so we delta-accumulate.
        const lastSeen = new WeakMap<object, { p: number; c: number; t: number; l: number }>()
        let totalPrompt = 0, totalCompletion = 0, totalTokens = 0, totalLlmCalls = 0

        return (childUsage: { promptTokens: number; completionTokens: number; totalTokens: number }, childLlmCalls: number) => {
          const prev = lastSeen.get(childUsage) ?? { p: 0, c: 0, t: 0, l: 0 }
          totalPrompt += childUsage.promptTokens - prev.p
          totalCompletion += childUsage.completionTokens - prev.c
          totalTokens += childUsage.totalTokens - prev.t
          totalLlmCalls += childLlmCalls - prev.l
          lastSeen.set(childUsage, { p: childUsage.promptTokens, c: childUsage.completionTokens, t: childUsage.totalTokens, l: childLlmCalls })

          // Sync to parent agent so persistTokenUsage captures planner-path totals
          agent.usage.promptTokens = totalPrompt
          agent.usage.completionTokens = totalCompletion
          agent.usage.totalTokens = totalTokens
          agent.llmCalls = totalLlmCalls

          broadcast({
            type: "usage.updated",
            data: {
              runId,
              promptTokens: totalPrompt,
              completionTokens: totalCompletion,
              totalTokens,
              llmCalls: totalLlmCalls,
            },
          })
        }
      })(),
    }
    const delegateTools = createDelegateTools(delegateCtx)

    // Create a run-scoped ask_user tool that blocks on user input via WS
    const runAskUserTool: Tool = {
      ...askUserTool,
      execute: async (args) => {
        const question = String(args.question ?? "")
        if (!question) return "Error: 'question' is required"
        const options = Array.isArray(args.options) ? args.options.map(String) : undefined
        const sensitive = Boolean(args.sensitive)

        // Save trace + broadcast to UI
        this.saveTrace(runId, { kind: "user-input-request", question, options, sensitive })
        broadcast({
          type: "user_input.required",
          data: { runId, question, options: options ?? [], sensitive },
        })

        // Block until user responds via POST /api/runs/:id/respond
        const response = await new Promise<string>((resolve) => {
          this.pendingInputs.set(runId, { resolve })
        })

        return response
      },
    }

    const allTools = [...governedTools, ...delegateTools, ...busTools, runAskUserTool]

    // Initialize effect tracking for this run
    resetEffectSeq(runId)

    // ── Build structured multi-message system prompt (agenc-core pattern) ──
    // Each section gets its own system message with a budget section tag.
    // This enables intelligent truncation: never drop the anchor, drop
    // least-critical sections first when approaching token limits.

    const systemMessages: Message[] = []

    // Section 1: system_anchor — base prompt + environment (NEVER dropped)
    const basePrompt = systemPrompt ?? undefined
    const envBlock = buildEnvironmentContext()
    const anchorContent = basePrompt
      ? `${basePrompt}\n${envBlock}`
      : envBlock
    systemMessages.push({
      role: "system",
      content: anchorContent,
      section: "system_anchor",
    })

    // Section 2: system_runtime — tool capabilities (droppable)
    const toolCtx = buildToolContext(allTools)
    if (toolCtx) {
      systemMessages.push({
        role: "system",
        content: toolCtx.trim(),
        section: "system_runtime",
      })
    }

    // Section 3: system_runtime — workspace context (droppable)
    if (runWorkspace.executionRoot) {
      const wsContext = await getWorkspaceContext(runWorkspace.executionRoot)
      const contextBlock = [
        `Workspace: ${runWorkspace.executionRoot}`,
        wsContext,
        "",
      ].join("\n")
      systemMessages.push({
        role: "system",
        content: contextBlock,
        section: "system_runtime",
      })
    }

    // Sections 4-6: memory tiers (each as separate message for independent truncation)
    const shouldUseMemory = !(runWorkspace.taskType === "code_generation" && !resume)
    const { perTier } = shouldUseMemory
      ? await retrieveContext(goal, { sessionId: agentId ?? "default", runId })
      : { perTier: { working: "", episodic: "", semantic: "" } }

    if (perTier.working) {
      systemMessages.push({
        role: "system",
        content: `<working_memory>\n${perTier.working}\n</working_memory>`,
        section: "memory_working",
      })
    }
    if (perTier.episodic) {
      systemMessages.push({
        role: "system",
        content: `<episodic_memory>\n${perTier.episodic}\n</episodic_memory>`,
        section: "memory_episodic",
      })
    }
    if (perTier.semantic) {
      systemMessages.push({
        role: "system",
        content: `<semantic_memory>\n${perTier.semantic}\n</semantic_memory>`,
        section: "memory_semantic",
      })
    }

    // For debug trace, concatenate all system messages into one view
    const effectivePrompt = systemMessages.map((m) => m.content).join("\n\n")

    // ── Debug trace: capture the full context the agent starts with ──
    let debugSeq = 0

    const systemPromptEntry = {
      kind: "system-prompt" as const,
      text: effectivePrompt ?? "(no system prompt)",
    }
    this.saveTrace(runId, systemPromptEntry)
    broadcast({ type: "debug.trace", data: { runId, seq: debugSeq++, entry: systemPromptEntry } })

    const toolsResolvedEntry = {
      kind: "tools-resolved" as const,
      tools: allTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    }
    this.saveTrace(runId, toolsResolvedEntry)
    broadcast({ type: "debug.trace", data: { runId, seq: debugSeq++, entry: toolsResolvedEntry } })

    let prevTotalTokens = 0

    // Build a per-run ToolKillManager so the user can kill individual tool calls
    const killManager: ToolKillManager = {
      register: (toolCallId: string, toolName: string) => {
        return new Promise<string>((resolve) => {
          const key = `${runId}:${toolCallId}`
          this.pendingKills.set(key, { resolve })
          broadcast({ type: "tool_call.executing", data: { runId, toolCallId, toolName } })
        })
      },
      unregister: (toolCallId: string) => {
        this.pendingKills.delete(`${runId}:${toolCallId}`)
        broadcast({ type: "tool_call.completed", data: { runId, toolCallId } })
      },
    }

    const agent = new Agent(this.llm, allTools, {
      verbose: true,
      signal: controller.signal,
      systemMessages,
      toolKillManager: killManager,
      // ── Planner-first routing ──────────────────────────────────
      enablePlanner: true,
      workspaceRoot: runWorkspace.executionRoot,
      onPlannerTrace: (entry) => {
        this.saveTrace(runId, entry)
        broadcast({ type: "debug.trace", data: { runId, seq: debugSeq++, entry } })

        // Key lifecycle events get dedicated WS types for audit/status widgets
        if (entry.kind === "planner-decision" && entry.shouldPlan) {
          broadcast({ type: "planner.started", data: { runId, score: entry.score, reason: entry.reason } })
          services.auditService.log({
            actor: "agent",
            action: "planner.started",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: { score: entry.score, reason: entry.reason },
          }).catch(() => {})
        } else if (entry.kind === "planner-pipeline-end") {
          broadcast({ type: "planner.completed", data: { runId, status: entry.status, completedSteps: entry.completedSteps, totalSteps: entry.totalSteps } })
          services.auditService.log({
            actor: "agent",
            action: entry.status === "completed" ? "planner.completed" : "planner.failed",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: { status: entry.status, completedSteps: entry.completedSteps, totalSteps: entry.totalSteps },
          }).catch(() => {})
        } else if (entry.kind === "planner-pipeline-start") {
          broadcast({
            type: "planner.pipeline.started",
            data: { runId, attempt: entry.attempt, maxRetries: entry.maxRetries },
          })
        } else if (entry.kind === "planner-validation-failed") {
          broadcast({
            type: "planner.validation.failed",
            data: {
              runId,
              diagnostics: entry.diagnostics,
            },
          })
          services.auditService.log({
            actor: "agent",
            action: "planner.validation.failed",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: { diagnostics: entry.diagnostics },
          }).catch(() => {})
        } else if (entry.kind === "planner-validation-remediated") {
          broadcast({
            type: "planner.validation.remediated",
            data: {
              runId,
              diagnostics: entry.diagnostics,
            },
          })
          services.auditService.log({
            actor: "agent",
            action: "planner.validation.remediated",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: { diagnostics: entry.diagnostics },
          }).catch(() => {})
        } else if (entry.kind === "planner-runtime-compiled") {
          broadcast({
            type: "planner.runtime.compiled",
            data: {
              runId,
              executionSteps: entry.executionSteps,
              ownershipArtifacts: entry.ownershipArtifacts,
              runtimeEntities: entry.runtimeEntities,
            },
          })
          services.auditService.log({
            actor: "agent",
            action: "planner.runtime.compiled",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: {
              executionSteps: entry.executionSteps,
              ownershipArtifacts: entry.ownershipArtifacts,
              runtimeEntities: entry.runtimeEntities,
            },
          }).catch(() => {})
        } else if (entry.kind === "planner-step-start") {
          broadcast({
            type: "planner.step.started",
            data: { runId, stepName: entry.stepName, stepType: entry.stepType },
          })
        } else if (entry.kind === "planner-step-end") {
          broadcast({
            type: "planner.step.completed",
            data: {
              runId,
              stepName: entry.stepName,
              status: entry.status,
              executionState: entry.executionState,
              acceptanceState: entry.acceptanceState,
              durationMs: entry.durationMs,
              error: entry.error,
              validationCode: entry.validationCode,
              producedArtifacts: entry.producedArtifacts,
              verificationAttempts: entry.verificationAttempts,
            },
          })
        } else if (entry.kind === "planner-delegation-start") {
          broadcast({
            type: "planner.delegation.started",
            data: {
              runId,
              stepName: entry.stepName,
              depth: entry.depth,
              goal: entry.goal,
              tools: entry.tools,
            },
          })
        } else if (entry.kind === "planner-delegation-iteration") {
          broadcast({
            type: "planner.delegation.iteration",
            data: {
              runId,
              stepName: entry.stepName,
              depth: entry.depth,
              iteration: entry.iteration,
              maxIterations: entry.maxIterations,
            },
          })
        } else if (entry.kind === "planner-delegation-end") {
          broadcast({
            type: "planner.delegation.ended",
            data: {
              runId,
              stepName: entry.stepName,
              depth: entry.depth,
              status: entry.status,
              answer: entry.answer,
              error: entry.error,
            },
          })
        } else if (entry.kind === "planner-verification") {
          broadcast({
            type: "planner.verification",
            data: {
              runId,
              overall: entry.overall,
              confidence: entry.confidence,
              steps: entry.steps,
            },
          })
          services.auditService.log({
            actor: "agent",
            action: "planner.verified",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: { overall: entry.overall, confidence: entry.confidence, steps: entry.steps },
          }).catch(() => {})
        } else if (entry.kind === "planner-repair-plan") {
          broadcast({
            type: "planner.repair.plan",
            data: {
              runId,
              attempt: entry.attempt,
              rerunOrder: entry.rerunOrder,
              tasks: entry.tasks,
            },
          })
          services.auditService.log({
            actor: "agent",
            action: "planner.repair.plan",
            resourceType: "AgentRun",
            resourceId: runId,
            detail: { attempt: entry.attempt, rerunOrder: entry.rerunOrder, tasks: entry.tasks },
          }).catch(() => {})
        }
      },
      plannerDelegateFn: (step, envelope) =>
        spawnChildForPlan(delegateCtx, step, envelope),
      onNudge: (data) => {
        const entry = {
          kind: "nudge" as const,
          tag: data.tag,
          message: data.message,
          iteration: data.iteration,
        }
        this.saveTrace(runId, entry)
        broadcast({ type: "debug.trace", data: { runId, seq: debugSeq++, entry } })
      },
      onLlmCall: (data) => {
        if (data.phase === "request") {
          const entry = {
            kind: "llm-request" as const,
            iteration: data.iteration,
            messageCount: data.messages.length,
            toolCount: data.tools.length,
            // Full message history for debugging
            messages: data.messages.map((m) => ({
              role: m.role,
              content: m.content,
              toolCalls: m.toolCalls?.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) ?? [],
              toolCallId: m.toolCallId ?? null,
            })),
          }
          this.saveTrace(runId, entry)
          broadcast({ type: "debug.trace", data: { runId, seq: debugSeq++, entry } })
        } else {
          const entry = {
            kind: "llm-response" as const,
            iteration: data.iteration,
            durationMs: data.durationMs,
            content: data.response.content,
            toolCalls: data.response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
            usage: data.response.usage ?? null,
          }
          this.saveTrace(runId, entry)
          broadcast({ type: "debug.trace", data: { runId, seq: debugSeq++, entry } })
        }
      },
      onThinking: (content, _toolCalls, iteration) => {
        // Fires right after LLM responds, BEFORE tool execution.
        // This ensures iteration + thinking appear before CALL/RSLT in the trace.

        const iterEntry = { kind: "iteration" as const, current: iteration + 1, max: 30 }
        this.saveTrace(runId, iterEntry)
        broadcast({ type: "debug.trace", data: { runId, seq: debugSeq++, entry: iterEntry } })

        if (content) {
          this.saveTrace(runId, { kind: "thinking", text: content })
          broadcast({
            type: "agent.thinking",
            data: { runId, content, iteration },
          })
        }

        // Broadcast token usage update
        const iterationTokens = agent.usage.totalTokens - prevTotalTokens
        prevTotalTokens = agent.usage.totalTokens

        // Save per-iteration token snapshot to trace
        const usageEntry = {
          kind: "usage" as const,
          iterationTokens,
          totalTokens: agent.usage.totalTokens,
          promptTokens: agent.usage.promptTokens,
          completionTokens: agent.usage.completionTokens,
          llmCalls: agent.llmCalls,
        }
        this.saveTrace(runId, usageEntry)
        broadcast({ type: "debug.trace", data: { runId, seq: debugSeq++, entry: usageEntry } })

        broadcast({
          type: "usage.updated",
          data: {
            runId,
            promptTokens: agent.usage.promptTokens,
            completionTokens: agent.usage.completionTokens,
            totalTokens: agent.usage.totalTokens,
            llmCalls: agent.llmCalls,
          },
        })
      },
      onStep: (messages, iteration) => {
        // Fires after tool execution — used for checkpointing only.
        lastMessages = messages
        lastIteration = iteration

        // Save checkpoint
        db.saveCheckpoint({
          run_id: runId,
          messages: JSON.stringify(messages),
          iteration,
          step_counter: state.stepCounter,
          updated_at: new Date().toISOString(),
        })
        broadcast({
          type: "checkpoint.saved",
          data: { runId, iteration, stepCounter: state.stepCounter },
        })

        // Persist current run state
        this.persistRun(run, goal, agentId, resume?.parentRunId)
      },
    })

    try {
      setShellSignal(controller.signal)
      const answer = await agent.run(goal, resume ? { messages: resume.messages, iteration: resume.iteration } : undefined)

      // Check if the run was cancelled (agent returns gracefully with cancel message)
      if (controller.signal.aborted) {
        cancelRun(run)
        await this.captureRunWorkspaceDiff(runId)

        await services.auditService.log({
          actor,
          action: "agent.cancelled",
          resourceType: "AgentRun",
          resourceId: run.id,
          detail: {
            goal,
            totalTokens: agent.usage.totalTokens,
            llmCalls: agent.llmCalls,
          },
        })

        this.persistRun(run, goal, agentId, resume?.parentRunId)
        this.persistAuditLog(services, runId)
        this.persistTokenUsage(runId, agent)

        broadcast({
          type: "run.cancelled",
          data: {
            runId,
            status: "cancelled",
            stepCount: run.steps.length,
            totalTokens: agent.usage.totalTokens,
            promptTokens: agent.usage.promptTokens,
            completionTokens: agent.usage.completionTokens,
            llmCalls: agent.llmCalls,
          },
        })

        this.createNotification({
          type: "run.cancelled",
          title: "Run cancelled",
          message: `"${goal.slice(0, 80)}" was cancelled after ${run.steps.length} steps.`,
          runId,
          actions: [
            { label: "View", action: "view-run", data: { runId } },
            { label: "Rollback", action: "rollback-run", data: { runId } },
          ],
        })

        return
      }

      // Complete the run
      completeRun(run)
      await services.eventBus.publish(runCompleted(run.id))

      await services.auditService.log({
        actor,
        action: "agent.completed",
        resourceType: "AgentRun",
        resourceId: run.id,
        detail: {
          goal,
          answer: answer.slice(0, 500),
          totalTokens: agent.usage.totalTokens,
          promptTokens: agent.usage.promptTokens,
          completionTokens: agent.usage.completionTokens,
          llmCalls: agent.llmCalls,
        },
      })

      // Persist final state
      this.persistRun(run, goal, agentId, resume?.parentRunId, answer)
      this.persistAuditLog(services, runId)
      this.persistTokenUsage(runId, agent)

      this.saveTrace(runId, { kind: "answer", text: answer })
      await this.captureRunWorkspaceDiff(runId)
      const pendingDiff = this.completedRunDiffs.get(runId)
      const pendingChangeCount = pendingDiff
        ? pendingDiff.added.length + pendingDiff.modified.length + pendingDiff.deleted.length
        : 0

      // Ingest all significant turns into unified memory
      const toolNames = run.steps.map((s) => s.action)
      const traceEvents = run.steps.map((s) => ({
        kind: "tool-call" as const,
        tool: s.action,
        text: `${s.action}(${Object.keys(s.input).join(", ")})`,
        argsSummary: Object.keys(s.input).join(", "),
      }))
      ingestRunTurns({
        id: runId,
        goal,
        answer,
        status: "completed",
        agentId,
        tools: [...new Set(toolNames)],
        stepCount: run.steps.length,
        trace: traceEvents,
      })

      // Extract procedural memory (tool sequences that worked)
      extractProcedural({ id: runId, goal, trace: traceEvents })

      // Periodic consolidation (promote episodic -> semantic)
      consolidate({ minAgeHours: 24 })

      broadcast({
        type: "run.completed",
        data: {
          runId,
          answer,
          status: "completed",
          stepCount: run.steps.length,
          totalTokens: agent.usage.totalTokens,
          promptTokens: agent.usage.promptTokens,
          completionTokens: agent.usage.completionTokens,
          llmCalls: agent.llmCalls,
          pendingWorkspaceChanges: pendingChangeCount,
        },
      })

      // Notify on completion
      this.createNotification({
        type: "run.completed",
        title: "Run completed",
        message: pendingChangeCount > 0
          ? `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps. ${pendingChangeCount} workspace changes pending approval.`
          : `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps.`,
        runId,
        actions: [
          { label: "View", action: "view-run", data: { runId } },
        ],
      })

      // Route reply to chat platform if this run was triggered by a message
      if (this.messageRouter) {
        this.messageRouter.sendReply(runId, answer).catch((err) => {
          console.error(`Failed to send reply for run ${runId}:`, err)
        })
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)

      failRun(run)
      await services.eventBus.publish(runFailed(run.id, errMsg))

      await services.auditService.log({
        actor,
        action: "agent.failed",
        resourceType: "AgentRun",
        resourceId: run.id,
        detail: {
          goal,
          error: errMsg,
          totalTokens: agent.usage.totalTokens,
          promptTokens: agent.usage.promptTokens,
          completionTokens: agent.usage.completionTokens,
          llmCalls: agent.llmCalls,
        },
      })

      // Save checkpoint for potential resume
      if (lastMessages.length > 0) {
        db.saveCheckpoint({
          run_id: runId,
          messages: JSON.stringify(lastMessages),
          iteration: lastIteration,
          step_counter: state.stepCounter,
          updated_at: new Date().toISOString(),
        })
        broadcast({
          type: "checkpoint.saved",
          data: { runId, iteration: lastIteration, stepCounter: state.stepCounter },
        })
      }

      this.persistRun(run, goal, agentId, resume?.parentRunId, undefined, errMsg)
      this.persistAuditLog(services, runId)
      this.persistTokenUsage(runId, agent)

      this.saveTrace(runId, { kind: "error", text: errMsg })
      await this.captureRunWorkspaceDiff(runId)

      // Ingest failed run into memory (lower confidence)
      const failedTools = run.steps.map((s) => s.action)
      const failedTrace = run.steps.map((s) => ({
        kind: "tool-call" as const,
        tool: s.action,
        text: `${s.action}(${Object.keys(s.input).join(", ")})`,
        argsSummary: Object.keys(s.input).join(", "),
      }))
      ingestRunTurns({
        id: runId,
        goal,
        answer: null,
        status: "failed",
        agentId,
        tools: [...new Set(failedTools)],
        stepCount: run.steps.length,
        error: errMsg,
        trace: failedTrace,
      })

      broadcast({
        type: "run.failed",
        data: {
          runId,
          error: errMsg,
          stepCount: run.steps.length,
          totalTokens: agent.usage.totalTokens,
          promptTokens: agent.usage.promptTokens,
          completionTokens: agent.usage.completionTokens,
          llmCalls: agent.llmCalls,
        },
      })

      // Notify on failure with resume action if checkpoint available
      const hasCheckpoint = !!db.getCheckpoint(runId)
      this.createNotification({
        type: "run.failed",
        title: "Run failed",
        message: `"${goal.slice(0, 80)}" failed: ${errMsg.slice(0, 120)}`,
        runId,
        actions: [
          { label: "Review", action: "view-run", data: { runId } },
          ...(hasCheckpoint ? [{ label: "Resume", action: "resume-run", data: { runId } }] : []),
          { label: "Rollback", action: "rollback-run", data: { runId } },
        ],
      })
    } finally {
      setShellSignal(null)
      releaseSlot()
      bus.dispose()
      this.pendingInputs.delete(runId)
      this.activeRuns.delete(runId)
    }
  }

  // ── Private: wire domain events to WebSocket ─────────────────

  private async withToolWorkspaceContext<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.toolContextQueue
    let release!: () => void
    this.toolContextQueue = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    setBasePath(workspaceRoot)
    setSearchBasePath(workspaceRoot)
    setShellCwd(workspaceRoot)
    setBrowserCheckCwd(workspaceRoot)

    try {
      return await fn()
    } finally {
      setBasePath(this.workspace ?? process.cwd())
      setSearchBasePath(this.workspace ?? process.cwd())
      setShellCwd(this.workspace ?? process.cwd())
      setBrowserCheckCwd(this.workspace ?? process.cwd())
      release()
    }
  }

  private async captureRunWorkspaceDiff(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId)
    if (!run?.workspace?.isolated) return

    const diff = await computeWorkspaceDiff(run.workspace.sourceRoot, run.workspace.executionRoot)
    this.completedRunWorkspaces.set(runId, run.workspace)
    this.completedRunDiffs.set(runId, diff)

    const total = diff.added.length + diff.modified.length + diff.deleted.length
    if (total === 0) {
      await cleanupRunWorkspace(run.workspace)
      this.completedRunWorkspaces.delete(runId)
      this.completedRunDiffs.delete(runId)
      return
    }

    if (total > 0) {
      this.saveTrace(runId, { kind: "workspace_diff", diff })
      broadcast({ type: "debug.trace", data: { runId, seq: Date.now(), entry: { kind: "workspace_diff", diff } } })
      this.createNotification({
        type: "run.completed",
        title: "Apply run changes",
        message: `Run ${runId.slice(0, 8)} produced ${total} isolated workspace changes pending approval.`,
        runId,
        actions: [
          { label: "Review", action: "view-run", data: { runId } },
          { label: "Apply", action: "apply-run-diff", data: { runId } },
        ],
      })
    }
  }

  getRunWorkspaceDiff(runId: string): WorkspaceDiff | null {
    return this.completedRunDiffs.get(runId) ?? null
  }

  async applyRunWorkspaceDiff(runId: string): Promise<{ added: number; modified: number; deleted: number } | null> {
    const context = this.completedRunWorkspaces.get(runId)
    const diff = this.completedRunDiffs.get(runId)
    if (!context || !diff) return null

    const summary = await applyWorkspaceDiff({
      sourceRoot: context.sourceRoot,
      executionRoot: context.executionRoot,
      diff,
    })
    await cleanupRunWorkspace(context)
    this.completedRunWorkspaces.delete(runId)
    this.completedRunDiffs.delete(runId)

    this.saveTrace(runId, { kind: "workspace_diff_applied", summary })
    broadcast({ type: "debug.trace", data: { runId, seq: Date.now(), entry: { kind: "workspace_diff_applied", summary } } })
    this.createNotification({
      type: "run.completed",
      title: "Run changes applied",
      message: `Applied ${summary.added + summary.modified + summary.deleted} file changes from isolated run ${runId.slice(0, 8)}.`,
      runId,
      actions: [{ label: "View", action: "view-run", data: { runId } }],
    })

    return summary
  }

  /**
   * Wrap a tool with effect tracking.
   * For write_file: captures pre-write snapshots and records file effects.
   * For run_command: records command effects.
   */
  private wrapWithEffects(tool: Tool, runId: string, workspaceRoot: string): Tool {
    if (tool.name === "write_file") {
      return {
        ...tool,
        execute: async (args) => this.withToolWorkspaceContext(workspaceRoot, async () => {
          const path = String(args.path)
          // Resolve to absolute path using workspace
          const { resolve } = await import("node:path")
          const absPath = resolve(workspaceRoot, path)

          // Record the effect with pre-write snapshot
          await recordFileWrite({
            runId,
            tool: "write_file",
            filePath: absPath,
            newContent: String(args.content),
          })

          // Execute the actual write
          return tool.execute(args)
        }),
      }
    }

    if (tool.name === "run_command") {
      return {
        ...tool,
        execute: async (args) => this.withToolWorkspaceContext(workspaceRoot, async () => {
          const result = await tool.execute(args)
          // Record command effect after execution
          recordEffect({
            runId,
            kind: "command",
            tool: "run_command",
            target: String(args.command ?? args.cmd ?? ""),
            metadata: { output: String(result).slice(0, 1000) },
          })
          return result
        }),
      }
    }

    return {
      ...tool,
      execute: async (args) => this.withToolWorkspaceContext(workspaceRoot, () => tool.execute(args)),
    }
  }

  private saveTrace(runId: string, entry: Record<string, unknown>): void {
    const active = this.activeRuns.get(runId)
    const seq = active ? active.traceSeq++ : 0
    db.saveTraceEntry({
      run_id: runId,
      seq,
      data: JSON.stringify(entry),
      created_at: new Date().toISOString(),
    })
  }

  private wireEventBroadcasting(
    services: EngineServices,
    runId: string,
    run: { steps: { id: string; name: string; action: string; input: Record<string, unknown>; output: Record<string, unknown>; error: string | null }[] },
  ): void {
    // Only subscribe to step events here — run.completed and run.failed
    // are broadcast explicitly with full data (answer, stepCount) after
    // the agent finishes, to avoid duplicate/incomplete broadcasts.
    const events = [
      "run.started",
      "step.started", "step.completed", "step.failed",
    ]
    for (const eventType of events) {
      services.eventBus.subscribe(eventType, async (event: DomainEvent) => {
        const data = event as unknown as Record<string, unknown>

        // Enrich step events with step details from the run
        if (eventType.startsWith("step.")) {
          const stepId = data["stepId"] as string
          const step = run.steps.find((s) => s.id === stepId)
          if (step) {
            data["name"] = step.name
            data["action"] = step.action
            data["input"] = step.input
            data["output"] = step.output
            data["error"] = step.error
          }
        }

        broadcast({ type: eventType, data })

        // Save trace entries for step events
        if (eventType === "step.started") {
          const toolName = (data["action"] as string) ?? "unknown"
          const input = (data["input"] as Record<string, unknown>) ?? {}
          const argsFormatted = JSON.stringify(input, null, 2)
          const keys = Object.keys(input)
          const argsSummary = keys.length > 0
            ? keys.length === 1 ? `${keys[0]}=${JSON.stringify(input[keys[0]])}`.slice(0, 60) : `${keys.length} args`
            : ""
          this.saveTrace(runId, { kind: "tool-call", tool: toolName, argsSummary, argsFormatted })
        } else if (eventType === "step.completed") {
          const output = (data["output"] as Record<string, unknown>) ?? {}
          const result = (output["result"] as string) ?? (Object.keys(output).length > 0 ? JSON.stringify(output) : "done")
          this.saveTrace(runId, { kind: "tool-result", text: result })
        } else if (eventType === "step.failed") {
          this.saveTrace(runId, { kind: "tool-error", text: (data["error"] as string) ?? "unknown error" })
        }

        // Save as log
        db.saveLog({
          run_id: runId,
          level: eventType.includes("failed") ? "error" : "info",
          message: `${eventType}: ${JSON.stringify(event)}`,
          timestamp: new Date().toISOString(),
        })
      })
    }

    // Intercept audit service to broadcast audit entries in real-time
    const originalLog = services.auditService.log.bind(services.auditService)
    services.auditService.log = async (entry) => {
      const result = await originalLog(entry)
      broadcast({
        type: "audit",
        data: {
          actor: entry.actor,
          action: entry.action,
          detail: entry.detail ?? {},
        },
      })
      return result
    }

    // Subscribe to approval requests — create notifications
    services.eventBus.subscribe("approval.required", async (event: DomainEvent) => {
      const data = event as unknown as Record<string, unknown>
      const toolName = data["toolName"] as string
      const reason = data["reason"] as string
      const stepId = data["stepId"] as string

      this.createNotification({
        type: "approval.required",
        title: "Approval required",
        message: `Tool "${toolName}" needs approval: ${reason}`,
        runId,
        stepId,
        actions: [
          { label: "Review", action: "view-run", data: { runId } },
          { label: "Edit Policies", action: "open-policies", data: { runId } },
        ],
      })

      broadcast({
        type: "approval.required",
        data: { runId, stepId, toolName, reason },
      })
    })
  }

  // ── Private: persist run to SQLite ───────────────────────────

  private persistRun(
    run: { id: string, status: string, steps: unknown[], createdAt: Date, completedAt: Date | null },
    goal: string,
    agentId: string | null,
    parentRunId?: string,
    answer?: string,
    error?: string,
  ): void {
    db.saveRun({
      id: run.id,
      goal,
      status: run.status,
      answer: answer ?? null,
      step_count: run.steps.length,
      error: error ?? null,
      parent_run_id: parentRunId ?? null,
      agent_id: agentId,
      data: JSON.stringify(run),
      created_at: run.createdAt.toISOString(),
      completed_at: run.completedAt?.toISOString() ?? null,
    })
  }

  // ── Private: persist audit log ───────────────────────────────

  private async persistAuditLog(services: EngineServices, runId: string): Promise<void> {
    const entries = await services.auditService.history("AgentRun", runId)
    for (const entry of entries) {
      db.saveAudit({
        run_id: runId,
        actor: entry.actor,
        action: entry.action,
        detail: JSON.stringify(entry.detail),
        timestamp: entry.timestamp.toISOString(),
      })
    }
  }

  // ── Private: persist token usage ─────────────────────────────

  private persistTokenUsage(runId: string, agent: Agent): void {
    if (agent.usage.totalTokens > 0 || agent.llmCalls > 0) {
      db.saveTokenUsage({
        run_id: runId,
        prompt_tokens: agent.usage.promptTokens,
        completion_tokens: agent.usage.completionTokens,
        total_tokens: agent.usage.totalTokens,
        llm_calls: agent.llmCalls,
        model: process.env["MODEL"] ?? "gpt-4o",
        created_at: new Date().toISOString(),
      })
    }
  }
}
