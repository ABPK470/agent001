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
    completeRun,
    createDelegateTool,
    createEngineServices,
    createRun,
    failRun,
    governTool,
    PolicyEffect,
    runCompleted,
    runFailed,
    runStarted,
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
} from "@agent001/agent"
import { randomUUID } from "node:crypto"
import type { MessageRouter } from "./channels/router.js"
import * as db from "./db.js"
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
}

// ── Orchestrator ─────────────────────────────────────────────────

export class AgentOrchestrator {
  private llm: LLMClient
  private readonly activeRuns = new Map<string, ActiveRun>()
  private messageRouter: MessageRouter | null = null

  constructor(config: OrchestratorConfig) {
    this.llm = config.llm
    this.messageRouter = config.messageRouter ?? null
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

    this.activeRuns.set(runId, { id: runId, goal, agentId, controller, services, traceSeq: 0 })

    broadcast({ type: "run.queued", data: { runId, goal, agentId } })
    this.saveTrace(runId, { kind: "goal", text: goal })

    this.executeRun(runId, goal, tools, config?.systemPrompt, agentId, services, controller).catch((err) => {
      console.error(`Run ${runId} crashed:`, err)
    })

    return runId
  }

  /** Cancel a running agent. */
  cancelRun(runId: string): boolean {
    const active = this.activeRuns.get(runId)
    if (!active) return false
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

    this.activeRuns.set(newRunId, {
      id: newRunId,
      goal: originalRun.goal,
      agentId: originalRun.agent_id ?? null,
      controller,
      services,
      traceSeq: 0,
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
    resume?: { messages: Message[], iteration: number, parentRunId: string },
  ): Promise<void> {
    const actor = "user"
    let lastMessages: Message[] = []
    let lastIteration = 0

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
      detail: { goal, tools: tools.map((t) => t.name), agentId },
    })

    // Save initial run to DB
    this.persistRun(run, goal, agentId, resume?.parentRunId)

    // Wrap tools with governance
    const state: RunState = {
      run,
      actor,
      stepCounter: resume?.iteration ?? 0,
    }
    const governedTools = tools.map((t) => governTool(t, services, state))

    // Create delegate tool for sub-agent spawning (ephemeral delegation)
    const maxDelegationDepth = Number(process.env["DELEGATION_MAX_DEPTH"]) || 3
    const delegateCtx: DelegateContext = {
      llm: this.llm,
      availableTools: governedTools,
      depth: 0,
      maxDepth: maxDelegationDepth,
      signal: controller.signal,
      resolveAgent: (agentId: string): ResolvedAgent | null => {
        const def = db.getAgentDefinition(agentId)
        if (!def) return null
        const toolNames = JSON.parse(def.tools) as string[]
        const agentTools = resolveTools(toolNames).map((t) => governTool(t, services, state))
        return {
          id: def.id,
          name: def.name,
          systemPrompt: def.system_prompt,
          tools: agentTools,
        }
      },
      onChildTrace: (entry) => {
        this.saveTrace(runId, entry)
        // Broadcast delegation events in real-time
        if (entry.kind === "delegation-start") {
          broadcast({ type: "delegation.started", data: { runId, ...entry } })
        } else if (entry.kind === "delegation-end") {
          broadcast({ type: "delegation.ended", data: { runId, ...entry } })
        }
      },
      onChildUsage: (childUsage) => {
        broadcast({
          type: "usage.updated",
          data: {
            runId,
            promptTokens: childUsage.promptTokens,
            completionTokens: childUsage.completionTokens,
            totalTokens: childUsage.totalTokens,
            llmCalls: 0,
          },
        })
      },
    }
    const delegateTool = createDelegateTool(delegateCtx)
    const allTools = delegateTool ? [...governedTools, delegateTool] : governedTools

    // Create agent with checkpoint support
    const agent = new Agent(this.llm, allTools, {
      verbose: true,
      signal: controller.signal,
      systemPrompt,
      onStep: (messages, iteration) => {
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

        // Broadcast thinking
        const lastAssistant = [...messages].reverse().find(
          (m) => m.role === "assistant" && m.content,
        )
        if (lastAssistant?.content) {
          this.saveTrace(runId, { kind: "iteration", current: iteration + 1, max: 30 })
          this.saveTrace(runId, { kind: "thinking", text: lastAssistant.content })
          broadcast({
            type: "agent.thinking",
            data: { runId, content: lastAssistant.content, iteration },
          })
        }

        // Broadcast token usage update
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

        // Persist current run state
        this.persistRun(run, goal, agentId, resume?.parentRunId)
      },
    })

    try {
      const answer = await agent.run(goal, resume ? {
        messages: resume.messages,
        iteration: resume.iteration,
      } : undefined)

      // Complete the run
      completeRun(run)
      await services.eventBus.publish(runCompleted(run.id))

      await services.auditService.log({
        actor,
        action: "agent.completed",
        resourceType: "AgentRun",
        resourceId: run.id,
        detail: { goal, answer: answer.slice(0, 500) },
      })

      // Persist final state
      this.persistRun(run, goal, agentId, resume?.parentRunId, answer)
      this.persistAuditLog(services, runId)
      this.persistTokenUsage(runId, agent)

      this.saveTrace(runId, { kind: "answer", text: answer })

      broadcast({
        type: "run.completed",
        data: { runId, answer, status: "completed", stepCount: run.steps.length },
      })

      // Notify on completion
      this.createNotification({
        type: "run.completed",
        title: "Run completed",
        message: `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps.`,
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
        detail: { goal, error: errMsg },
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
      }

      this.persistRun(run, goal, agentId, resume?.parentRunId, undefined, errMsg)
      this.persistAuditLog(services, runId)
      this.persistTokenUsage(runId, agent)

      this.saveTrace(runId, { kind: "error", text: errMsg })

      broadcast({
        type: "run.failed",
        data: { runId, error: errMsg, stepCount: run.steps.length },
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
        ],
      })
    } finally {
      this.activeRuns.delete(runId)
    }
  }

  // ── Private: wire domain events to WebSocket ─────────────────

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
