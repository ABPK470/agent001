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
    createEngineServices,
    governTool,
    type EngineServices,
    type LLMClient,
    type Message,
    type RunState,
    type Tool,
} from "@agent001/agent"
import {
    completeRun,
    createRun,
    failRun,
    runCompleted,
    runFailed,
    runStarted,
    startPlanning,
    startRunning,
    type DomainEvent,
} from "@agent001/engine"
import { randomUUID } from "node:crypto"
import * as db from "./db.js"
import { broadcast } from "./ws.js"

// ── Types ────────────────────────────────────────────────────────

interface ActiveRun {
  id: string
  goal: string
  controller: AbortController
  services: EngineServices
}

export interface OrchestratorConfig {
  llm: LLMClient
  tools: Tool[]
}

// ── Orchestrator ─────────────────────────────────────────────────

export class AgentOrchestrator {
  private readonly llm: LLMClient
  private readonly tools: Tool[]
  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(config: OrchestratorConfig) {
    this.llm = config.llm
    this.tools = config.tools
  }

  /** Start a new governed agent run. Returns the run ID immediately. */
  startRun(goal: string): string {
    const runId = randomUUID()
    const controller = new AbortController()
    const services = createEngineServices()

    // Load persisted policy rules into this run's evaluator
    const dbRules = db.listPolicyRules()
    for (const r of dbRules) {
      services.policyEvaluator.addRule({
        name: r.name,
        effect: r.effect as unknown as import("@agent001/engine").PolicyEffect,
        condition: r.condition,
        parameters: JSON.parse(r.parameters),
      })
    }

    this.activeRuns.set(runId, { id: runId, goal, controller, services })

    broadcast({ type: "run.queued", data: { runId, goal } })

    this.executeRun(runId, goal, services, controller).catch((err) => {
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

    const newRunId = randomUUID()
    const controller = new AbortController()
    const services = createEngineServices()

    this.activeRuns.set(newRunId, {
      id: newRunId,
      goal: originalRun.goal,
      controller,
      services,
    })

    broadcast({
      type: "run.queued",
      data: { runId: newRunId, goal: originalRun.goal, resumedFrom: runId },
    })

    const messages = JSON.parse(checkpoint.messages) as Message[]
    const iteration = checkpoint.iteration

    this.executeRun(
      newRunId,
      originalRun.goal,
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

  // ── Private: execute a governed agent run ────────────────────

  private async executeRun(
    runId: string,
    goal: string,
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
      detail: { goal, tools: this.tools.map((t) => t.name) },
    })

    // Save initial run to DB
    this.persistRun(run, goal, resume?.parentRunId)

    // Wrap tools with governance
    const state: RunState = {
      run,
      actor,
      stepCounter: resume?.iteration ?? 0,
    }
    const governedTools = this.tools.map((t) => governTool(t, services, state))

    // Create agent with checkpoint support
    const agent = new Agent(this.llm, governedTools, {
      verbose: true,
      signal: controller.signal,
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
          broadcast({
            type: "agent.thinking",
            data: { runId, content: lastAssistant.content, iteration },
          })
        }

        // Persist current run state
        this.persistRun(run, goal, resume?.parentRunId)
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
      this.persistRun(run, goal, resume?.parentRunId, answer)
      this.persistAuditLog(services, runId)

      broadcast({
        type: "run.completed",
        data: { runId, answer, status: "completed", stepCount: run.steps.length },
      })
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

      this.persistRun(run, goal, resume?.parentRunId, undefined, errMsg)
      this.persistAuditLog(services, runId)

      broadcast({
        type: "run.failed",
        data: { runId, error: errMsg, stepCount: run.steps.length },
      })
    } finally {
      this.activeRuns.delete(runId)
    }
  }

  // ── Private: wire domain events to WebSocket ─────────────────

  private wireEventBroadcasting(
    services: EngineServices,
    runId: string,
    run: { steps: { id: string; name: string; action: string; input: Record<string, unknown>; output: Record<string, unknown>; error: string | null }[] },
  ): void {
    const events = [
      "run.started", "run.completed", "run.failed",
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
  }

  // ── Private: persist run to SQLite ───────────────────────────

  private persistRun(
    run: { id: string, status: string, steps: unknown[], createdAt: Date, completedAt: Date | null },
    goal: string,
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
}
