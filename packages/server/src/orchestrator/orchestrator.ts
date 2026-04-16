import {
    createEngineServices,
    PolicyEffect,
    type LLMClient,
    type Message,
    type Tool,
} from "@agent001/agent"
import { randomUUID } from "node:crypto"
import { AgentBus } from "../agent-bus.js"
import type { MessageRouter } from "../channels/router.js"
import * as db from "../db.js"
import { migrateEffects } from "../effects.js"
import { migrateMemory } from "../memory.js"
import { RunQueue, type RunPriority } from "../queue.js"
import type { RunWorkspaceContext, WorkspaceDiff } from "../run-workspace.js"
import { cleanupStaleRunWorkspaces } from "../run-workspace.js"
import { getAllTools, resolveTools } from "../tools.js"
import { broadcast } from "../ws.js"
import { createNotification, saveTrace } from "./persistence.js"
import { recoverStaleRunsImpl } from "./recovery.js"
import { executeRunImpl } from "./run-executor.js"
import type { ActiveRun, AgentRunConfig, NotificationOpts, OrchestratorConfig, OrchestratorRunCtx } from "./types.js"
import { applyRunWorkspaceDiff } from "./workspace-effects.js"

// ── AgentOrchestrator ─────────────────────────────────────────────

export class AgentOrchestrator {
  private llm: LLMClient
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly pendingInputs = new Map<string, { resolve: (answer: string) => void }>()
  private readonly pendingKills = new Map<string, { resolve: (message: string) => void; perToolCtrl: AbortController }>()
  private readonly queue: RunQueue
  private messageRouter: MessageRouter | null = null
  private workspace: string | null = null
  private readonly completedRunWorkspaces = new Map<string, RunWorkspaceContext>()
  private readonly completedRunDiffs = new Map<string, WorkspaceDiff>()
  private readonly toolContextQueueRef = { current: Promise.resolve() }

  constructor(config: OrchestratorConfig) {
    this.llm = config.llm
    this.messageRouter = config.messageRouter ?? null
    this.workspace = config.workspace ?? null
    this.queue = new RunQueue()
    migrateMemory()
    migrateEffects()
    const ttlMs = Number(process.env["AGENT_RUN_WORKSPACE_TTL_MS"] ?? 6 * 60 * 60 * 1000)
    if (Number.isFinite(ttlMs) && ttlMs >= 0) {
      void cleanupStaleRunWorkspaces(ttlMs)
    }
  }

  // ── Configuration ─────────────────────────────────────────────

  setWorkspace(path: string): void { this.workspace = path }
  setLlm(client: LLMClient): void { this.llm = client }
  setMessageRouter(router: MessageRouter): void { this.messageRouter = router }

  // ── Run lifecycle ─────────────────────────────────────────────

  startRun(goal: string, config?: AgentRunConfig): string {
    const runId = randomUUID()
    const controller = new AbortController()
    const services = createEngineServices()
    const agentId = config?.agentId ?? null
    const tools = config?.tools ?? getAllTools()
    const bus = new AgentBus(runId)

    const dbRules = db.listPolicyRules()
    for (const r of dbRules) {
      services.policyEvaluator.addRule({ name: r.name, effect: r.effect as PolicyEffect, condition: r.condition, parameters: JSON.parse(r.parameters) })
    }

    this.activeRuns.set(runId, { id: runId, goal, agentId, controller, services, traceSeq: 0, bus, workspace: null })
    broadcast({ type: "run.queued", data: { runId, goal, agentId, queueStats: this.queue.stats() } })
    saveTrace(this.activeRuns, runId, { kind: "goal", text: goal })

    this.executeRun(runId, goal, tools, config?.systemPrompt, agentId, services, controller, bus).catch((err) => {
      console.error(`Run ${runId} crashed:`, err)
    })

    return runId
  }

  cancelRun(runId: string): boolean {
    const active = this.activeRuns.get(runId)
    if (!active) return this.queue.remove(runId)
    active.controller.abort()
    broadcast({ type: "run.cancelled", data: { runId } })
    return true
  }

  resumeRun(runId: string): string | null {
    const checkpoint = db.getCheckpoint(runId)
    const originalRun = db.getRun(runId)
    if (!checkpoint || !originalRun) return null
    if (this.activeRuns.has(runId)) return null
    if (originalRun.status === "completed") return null

    const existingRuns = db.listRuns(200)
    const alreadyResumed = existingRuns.find((r) => r.parent_run_id === runId && (r.status === "running" || r.status === "pending" || r.status === "planning"))
    if (alreadyResumed) return alreadyResumed.id

    const newRunId = randomUUID()
    const controller = new AbortController()
    const services = createEngineServices()
    const bus = new AgentBus(newRunId)

    this.activeRuns.set(newRunId, { id: newRunId, goal: originalRun.goal, agentId: originalRun.agent_id ?? null, controller, services, traceSeq: 0, bus, workspace: null })
    broadcast({ type: "run.queued", data: { runId: newRunId, goal: originalRun.goal, resumedFrom: runId } })
    saveTrace(this.activeRuns, newRunId, { kind: "goal", text: originalRun.goal })

    const messages = JSON.parse(checkpoint.messages) as Message[]
    const iteration = checkpoint.iteration
    let tools = getAllTools()
    let systemPrompt: string | undefined
    if (originalRun.agent_id) {
      const agentDef = db.getAgentDefinition(originalRun.agent_id)
      if (agentDef) {
        tools = resolveTools(JSON.parse(agentDef.tools) as string[])
        systemPrompt = agentDef.system_prompt
      }
    }

    this.executeRun(newRunId, originalRun.goal, tools, systemPrompt, originalRun.agent_id ?? null, services, controller, bus, { messages, iteration, parentRunId: runId }).catch((err) => {
      console.error(`Resumed run ${newRunId} crashed:`, err)
    })

    return newRunId
  }

  // ── Queries ───────────────────────────────────────────────────

  getActiveRunIds(): string[] { return [...this.activeRuns.keys()] }
  getQueueStats() { return this.queue.stats() }

  respondToRun(runId: string, response: string): boolean {
    const pending = this.pendingInputs.get(runId)
    if (!pending) return false
    pending.resolve(response)
    this.pendingInputs.delete(runId)
    saveTrace(this.activeRuns, runId, { kind: "user-input-response", text: response })
    broadcast({ type: "user_input.response", data: { runId } })
    return true
  }

  killToolCall(runId: string, toolCallId: string, message: string): boolean {
    const key = `${runId}:${toolCallId}`
    const pending = this.pendingKills.get(key)
    if (!pending) return false
    pending.perToolCtrl.abort()
    pending.resolve(message)
    this.pendingKills.delete(key)
    broadcast({ type: "tool_call.killed", data: { runId, toolCallId, message } })
    return true
  }

  recoverStaleRuns(): { recovered: string[]; failed: string[] } {
    return recoverStaleRunsImpl(this)
  }

  // ── Notifications ─────────────────────────────────────────────

  createNotification(opts: NotificationOpts): void {
    createNotification(opts)
  }

  // ── Workspace diff ────────────────────────────────────────────

  getRunWorkspaceDiff(runId: string): WorkspaceDiff | null {
    return this.completedRunDiffs.get(runId) ?? null
  }

  async applyRunWorkspaceDiff(runId: string): Promise<{ added: number; modified: number; deleted: number } | null> {
    const boundSave = (rId: string, entry: Record<string, unknown>) => saveTrace(this.activeRuns, rId, entry)
    return applyRunWorkspaceDiff(runId, this.completedRunWorkspaces, this.completedRunDiffs, boundSave, createNotification)
  }

  // ── Private: delegate to run-executor ────────────────────────

  private getCtx(): OrchestratorRunCtx {
    return {
      llm: this.llm,
      workspace: this.workspace,
      queue: this.queue,
      activeRuns: this.activeRuns,
      pendingInputs: this.pendingInputs,
      pendingKills: this.pendingKills,
      completedRunWorkspaces: this.completedRunWorkspaces,
      completedRunDiffs: this.completedRunDiffs,
      messageRouter: this.messageRouter,
      toolContextQueueRef: this.toolContextQueueRef,
    }
  }

  private async executeRun(
    runId: string,
    goal: string,
    tools: Tool[],
    systemPrompt: string | undefined,
    agentId: string | null,
    services: ReturnType<typeof createEngineServices>,
    controller: AbortController,
    bus: AgentBus,
    resume?: { messages: Message[]; iteration: number; parentRunId: string },
    priority: RunPriority = "normal",
  ): Promise<void> {
    return executeRunImpl(this.getCtx(), runId, goal, tools, systemPrompt, agentId, services, controller, bus, resume, priority)
  }
}
