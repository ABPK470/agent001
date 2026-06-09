import {
  computeAutoDetectedExcludeDirs,
  configureAgent,
  createEngineServices,
  EventType,
  PolicyEffect,
  PolicyRole,
  RunStatus,
  type LLMClient,
  type Message,
  type Tool
} from "@mia/agent"
import { randomUUID } from "node:crypto"
import { bootHostDepsToConfigureAgentOptions } from "../../bootstrap/config.js"
import type { RunWorkspaceContext, WorkspaceDiff } from "../../bootstrap/workspace.js"
import { cleanupStaleRunWorkspaces } from "../../bootstrap/workspace.js"
import { migrateEffects } from "../../platform/effects/index.js"
import { broadcast } from "../../platform/events/broadcaster.js"
import { cleanupExpiredCache, migrateMemory } from "../../platform/persistence/index.js"
import * as db from "../../platform/persistence/sqlite.js"
import { AgentBus, createBusTools } from "../../platform/queue/agent-bus.js"
import { RunPriority, RunQueue } from "../../platform/queue/run-queue.js"
import type { MessageRouterPort } from "../../ports/channels.js"
import type {
  ActiveRun,
  AgentRunConfig,
  BootHostDeps,
  NotificationOpts,
  OrchestratorConfig
} from "../../ports/orchestration.js"
import { TrajectoryEventKind } from "../../shared/enums/trajectory.js"
import { filterToolsForVisitor, getAllTools } from "../agents/tools.js"
import type { CurrentSession } from "../auth/context.js"
import { ClarificationsRegistry } from "./execution/clarifications-registry.js"
import { createNotification, saveTrace } from "./execution/persistence.js"
import { recoverStaleRunsImpl } from "./execution/recovery.js"
import { executeRunImpl } from "./execution/run-executor.js"
import type { ExecuteRunCommand } from "./execution/run-executor/types.js"
import { applyRunWorkspaceDiff, captureRunWorkspaceDiff } from "./execution/workspace-effects.js"

export type { AgentRunConfig, OrchestratorConfig } from "../../ports/orchestration.js"

// ── AgentOrchestrator ─────────────────────────────────────────────

export class AgentOrchestrator {
  private llm: LLMClient
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly pendingInputs = new Map<string, { resolve: (answer: string) => void }>()
  private readonly pendingKills = new Map<
    string,
    { resolve: (message: string) => void; perToolCtrl: AbortController }
  >()
  private readonly clarifications = new ClarificationsRegistry()
  private readonly queue: RunQueue
  private messageRouter: MessageRouterPort | null = null
  private workspace: string | null = null
  private readonly bootHostDeps: BootHostDeps
  private readonly completedRunWorkspaces = new Map<string, RunWorkspaceContext>()
  private readonly completedRunDiffs = new Map<string, WorkspaceDiff>()

  constructor(config: OrchestratorConfig) {
    this.llm = config.llm
    this.messageRouter = config.messageRouter ?? null
    this.workspace = config.workspace ?? null
    this.bootHostDeps = config.bootHostDeps
    this.queue = new RunQueue()
    migrateMemory()
    migrateEffects()
    const ttlMs = Number(process.env["AGENT_RUN_WORKSPACE_TTL_MS"] ?? 6 * 60 * 60 * 1000)
    if (Number.isFinite(ttlMs) && ttlMs >= 0) {
      void cleanupStaleRunWorkspaces(ttlMs)
    }
    // Tool-cache TTL is per-entry (encoded in each cache file). The boot
    // sweep here drops anything that already expired so the disk does not
    // accumulate orphans across restarts.
    void cleanupExpiredCache().catch(() => {})
  }

  // ── Configuration ─────────────────────────────────────────────

  setWorkspace(path: string): void {
    this.workspace = path
  }
  setLlm(client: LLMClient): void {
    this.llm = client
  }
  setMessageRouter(router: MessageRouterPort): void {
    this.messageRouter = router
  }

  // ── Run lifecycle ─────────────────────────────────────────────

  startRun(goal: string, config?: AgentRunConfig, session: CurrentSession | null = null): string {
    const runId = randomUUID()
    const controller = new AbortController()
    const services = createEngineServices()
    const agentId = config?.agentId ?? null
    // When the caller didn't supply an explicit tool list, build per-run
    // tools from boot deps + the orchestrator's workspace. This is the
    // pre-run host used only to size the registry; the actual execute-time
    // host is rebuilt inside run-executor with the run-workspace path.
    let tools = config?.tools ?? this.buildBootTools()
    // Visitor allowlist: non-admin sessions get the safe subset (no shell, no
    // headless browser). Captured here at run-start time when AsyncLocalStorage
    // still holds the originating request's session. Admin sessions get the
    // full toolset unchanged.
    const role: PolicyRole = !session
      ? PolicyRole.Admin
      : session.isAdmin
        ? PolicyRole.Admin
        : PolicyRole.HostedUser
    if (session && !session.isAdmin) {
      tools = filterToolsForVisitor(tools)
    }
    const bus = new AgentBus(runId)

    const dbRules = db.listPolicyRules()
    for (const r of dbRules) {
      services.policyEvaluator.addRule({
        name: r.name,
        effect: r.effect as PolicyEffect,
        condition: r.condition,
        parameters: JSON.parse(r.parameters)
      })
    }
    // Hosted-default and per-env-derived rules live in the DB now (seeded
    // at server boot via policy-seeder.ts). Operators edit/delete them
    // through the admin UI; this loop already loaded them above.

    this.activeRuns.set(runId, {
      id: runId,
      goal,
      agentId,
      controller,
      services,
      traceSeq: 0,
      bus,
      workspace: null,
      role,
      attachmentIds: config?.attachmentIds ?? [],
      ownerUpn: session?.upn ?? null,
      sessionId: session?.sid ?? null
    })

    // Persist the run row BEFORE broadcasting or writing trace entries.
    // trace_entries.run_id has a hard FK to runs(id), so saveTrace below
    // would fail with SQLITE_CONSTRAINT_FOREIGNKEY otherwise. Doing this
    // first also means: cancel route (which checks db.getRun) can find
    // the row immediately, and SSE consumers never see a `run.queued`
    // event for a run that does not exist server-side.
    db.saveRun({
      id: runId,
      goal,
      status: RunStatus.Pending,
      answer: null,
      step_count: 0,
      error: null,
      parent_run_id: null,
      agent_id: agentId,
      created_at: new Date().toISOString(),
      completed_at: null,
      session_id: session?.sid ?? null,
      upn: session?.upn ?? null,
      display_name: session?.displayName ?? null
    })

    broadcast({
      type: EventType.RunQueued,
      data: { runId, goal, agentId, queueStats: this.queue.stats() }
    })
    saveTrace(this.activeRuns, runId, { kind: TrajectoryEventKind.Goal, text: goal })

    const command = this.buildRunCommand({
      runId,
      goal,
      tools,
      systemPrompt: config?.systemPrompt,
      agentId,
      services,
      controller,
      bus,
      priority: RunPriority.Normal
    })

    this.executeRun(command).catch((err) => {
      console.error(`Run ${runId} crashed:`, err)
      // executeRun threw before its own try/catch could mark the run
      // failed (e.g. crash during prepareWorkspace). Without this the
      // runs row stays at status="queued" forever and the UI's
      // PIPELINES widget shows a perpetual "running" badge. Persist
      // a failed status and emit run.failed so all SSE consumers can
      // settle their local state.
      const message = err instanceof Error ? err.message : String(err)
      try {
        const existing = db.getRun(runId)
        db.saveRun({
          id: runId,
          goal,
          status: RunStatus.Failed,
          answer: existing?.answer ?? null,
          step_count: existing?.step_count ?? 0,
          error: message,
          parent_run_id: existing?.parent_run_id ?? null,
          agent_id: agentId,
          created_at: existing?.created_at ?? new Date().toISOString(),
          completed_at: new Date().toISOString(),
          session_id: existing?.session_id ?? session?.sid ?? null,
          upn: existing?.upn ?? session?.upn ?? null,
          display_name: existing?.display_name ?? session?.displayName ?? null
        })
      } catch (persistErr) {
        console.error(`Failed to persist failure for run ${runId}:`, persistErr)
      }
      broadcast({ type: EventType.RunFailed, data: { runId, error: message } })
      this.activeRuns.delete(runId)
    })

    return runId
  }

  cancelRun(runId: string): boolean {
    const active = this.activeRuns.get(runId)
    if (!active) {
      // No in-memory run — it's either queued, or stuck in DB as 'running'
      // because a previous run never observed its abort signal. Persist the
      // cancel either way so list/status calls reflect reality immediately.
      db.markRunCancelled(runId)
      const removed = this.queue.remove(runId)
      broadcast({ type: EventType.RunCancelled, data: { runId } })
      return removed || true
    }
    active.controller.abort()
    // Persist eagerly. The executor's abort handler also persists once the
    // loop unwinds, but if the LLM call hangs and never observes the signal
    // the row would stay 'running' forever. This is a no-op if the loop
    // races us to completion (markRunCancelled only touches active rows).
    db.markRunCancelled(runId)
    broadcast({ type: EventType.RunCancelled, data: { runId } })
    return true
  }

  resumeRun(runId: string, resumeSession: CurrentSession | null = null): string | null {
    const checkpoint = db.getCheckpoint(runId)
    const originalRun = db.getRun(runId)
    if (!checkpoint || !originalRun) return null
    if (this.activeRuns.has(runId)) return null
    if (originalRun.status === RunStatus.Completed) return null

    const existingRuns = db.listRuns(200)
    const alreadyResumed = existingRuns.find(
      (r) =>
        r.parent_run_id === runId &&
        (r.status === RunStatus.Running || r.status === RunStatus.Pending || r.status === RunStatus.Planning)
    )
    if (alreadyResumed) return alreadyResumed.id

    const newRunId = randomUUID()
    const controller = new AbortController()
    const services = createEngineServices()
    const bus = new AgentBus(newRunId)

    // Load operator-defined rules and (when applicable) hosted defaults so a
    // resumed run is policed identically to a fresh start. Previously the
    // resume path skipped rule loading entirely, leaving the policy engine
    // empty for the rest of the run.
    const dbRules = db.listPolicyRules()
    for (const r of dbRules) {
      services.policyEvaluator.addRule({
        name: r.name,
        effect: r.effect as PolicyEffect,
        condition: r.condition,
        parameters: JSON.parse(r.parameters)
      })
    }
    // (See startRun: hosted defaults + env-derived rules now seeded into
    // policy_rules at server boot via policy-seeder.ts, so loading dbRules
    // above already covers them.)

    const resumeRole: PolicyRole = !resumeSession
      ? PolicyRole.Admin
      : resumeSession.isAdmin
        ? PolicyRole.Admin
        : PolicyRole.HostedUser
    this.activeRuns.set(newRunId, {
      id: newRunId,
      goal: originalRun.goal,
      agentId: originalRun.agent_id ?? null,
      controller,
      services,
      traceSeq: 0,
      bus,
      workspace: null,
      role: resumeRole,
      attachmentIds: [],
      ownerUpn: resumeSession?.upn ?? null,
      sessionId: resumeSession?.sid ?? null
    })

    // Persist the resumed-run row BEFORE broadcasting or writing trace
    // entries. trace_entries.run_id has a hard FK to runs(id), so the
    // saveTrace below would fail with SQLITE_CONSTRAINT_FOREIGNKEY
    // otherwise (mirrors the same ordering invariant in startRun).
    db.saveRun({
      id: newRunId,
      goal: originalRun.goal,
      status: RunStatus.Pending,
      answer: null,
      step_count: 0,
      error: null,
      parent_run_id: runId,
      agent_id: originalRun.agent_id ?? null,
      created_at: new Date().toISOString(),
      completed_at: null,
      session_id: resumeSession?.sid ?? null,
      upn: resumeSession?.upn ?? null,
      display_name: resumeSession?.displayName ?? null
    })

    broadcast({
      type: EventType.RunQueued,
      data: { runId: newRunId, goal: originalRun.goal, resumedFrom: runId }
    })
    saveTrace(this.activeRuns, newRunId, { kind: TrajectoryEventKind.Goal, text: originalRun.goal })

    const messages = JSON.parse(checkpoint.messages) as Message[]
    const iteration = checkpoint.iteration
    let tools = this.buildBootTools()
    let systemPrompt: string | undefined
    if (originalRun.agent_id) {
      const agentDef = db.getAgentDefinition(originalRun.agent_id)
      if (agentDef) systemPrompt = db.resolveAgentSystemPrompt(agentDef)
    }
    // Visitor allowlist on resume too — safety net even if agentDef requests
    // tools the visitor isn't allowed to use.
    if (resumeSession && !resumeSession.isAdmin) {
      tools = filterToolsForVisitor(tools)
    }

    const command = this.buildRunCommand({
      runId: newRunId,
      goal: originalRun.goal,
      tools,
      systemPrompt,
      agentId: originalRun.agent_id ?? null,
      services,
      controller,
      bus,
      resume: { messages, iteration, parentRunId: runId },
      priority: RunPriority.Normal
    })

    this.executeRun(command).catch((err) => {
      console.error(`Resumed run ${newRunId} crashed:`, err)
    })

    return newRunId
  }

  // ── Queries ───────────────────────────────────────────────────

  getActiveRunIds(): string[] {
    return [...this.activeRuns.keys()]
  }
  getQueueStats() {
    return this.queue.stats()
  }

  respondToRun(runId: string, response: string): boolean {
    const pending = this.pendingInputs.get(runId)
    if (!pending) return false
    pending.resolve(response)
    this.pendingInputs.delete(runId)
    // Resolve any pending clarification finding this answer corresponds to.
    // Round number is best-effort — we use the active run's traceSeq as a
    // coarse proxy because the orchestrator does not track LLM-round number
    // here. Detector context only consults presence/absence, not the value.
    const round = this.activeRuns.get(runId)?.traceSeq ?? 0
    const resolvedClarification = this.clarifications.resolvePending(runId, response, round)
    if (resolvedClarification) {
      saveTrace(this.activeRuns, runId, {
        kind: TrajectoryEventKind.ClarificationResolved,
        findingId: resolvedClarification.findingId,
        subject: resolvedClarification.subject
      } as unknown as Record<string, unknown>)
    }
    saveTrace(this.activeRuns, runId, { kind: TrajectoryEventKind.UserInputResponse, text: response })
    broadcast({ type: EventType.UserInputResponse, data: { runId } })
    return true
  }

  killToolCall(runId: string, toolCallId: string, message: string): boolean {
    const key = `${runId}:${toolCallId}`
    const pending = this.pendingKills.get(key)
    if (!pending) return false
    pending.perToolCtrl.abort()
    pending.resolve(message)
    this.pendingKills.delete(key)
    broadcast({ type: EventType.ToolCallKilled, data: { runId, toolCallId, message } })
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

  getRunWorkspaceSourceRoot(runId: string): string | null {
    return this.completedRunWorkspaces.get(runId)?.sourceRoot ?? null
  }

  getRunWorkspaceExecutionRoot(runId: string): string | null {
    return this.completedRunWorkspaces.get(runId)?.executionRoot ?? null
  }

  async applyRunWorkspaceDiff(
    runId: string
  ): Promise<{ added: number; modified: number; deleted: number } | null> {
    const boundSave = (rId: string, entry: Record<string, unknown>) => saveTrace(this.activeRuns, rId, entry)
    return applyRunWorkspaceDiff(
      runId,
      this.completedRunWorkspaces,
      this.completedRunDiffs,
      boundSave,
      createNotification
    )
  }

  // ── Private: delegate to run-executor ────────────────────────

  /**
   * Build a transient host + tool list at run-queue time. Used only for
   * the registry passed to executeRun; the executor itself rebuilds the
   * host with the actual run-workspace root before constructing the
   * Agent. Tools that close over `host.filesystem.basePath` here will
   * therefore be overwritten — what matters is that the tool *set* matches
   * what filterToolsForVisitor / filterToolsByGoal expect.
   */
  private buildBootTools(): Tool[] {
    const root = this.workspace ?? process.cwd()
    const host = configureAgent({
      ...bootHostDepsToConfigureAgentOptions(this.bootHostDeps),
      workspaceRoot: root,
      filesystemBasePath: root,
      searchFilesBasePath: root,
      searchFilesExcludeDirs: new Set(computeAutoDetectedExcludeDirs(root)),
      shellCwd: root,
      browserCheckCwd: root
    })
    return getAllTools(host)
  }

  private buildRunCommand(args: {
    runId: string
    goal: string
    tools: Tool[]
    systemPrompt: string | undefined
    agentId: string | null
    services: ReturnType<typeof createEngineServices>
    controller: AbortController
    bus: AgentBus
    priority: RunPriority
    resume?: { messages: Message[]; iteration: number; parentRunId: string }
  }): ExecuteRunCommand {
    const { runId, goal, tools, systemPrompt, agentId, services, controller, bus, priority, resume } = args

    return {
      request: {
        runId,
        goal,
        tools,
        systemPrompt,
        agentId,
        resume,
        priority
      },
      runtime: {
        workspaceRoot: this.workspace,
        queue: {
          acquire: (queuedRunId, queuedPriority, signal) =>
            this.queue.acquire(queuedRunId, queuedPriority, signal)
        },
        interaction: {
          llm: this.llm,
          clarifications: this.clarifications,
          registerPendingInput: (pendingRunId, pending) => {
            this.pendingInputs.set(pendingRunId, pending)
          },
          clearPendingInput: (pendingRunId) => {
            this.pendingInputs.delete(pendingRunId)
          },
          registerPendingKill: (key, pending) => {
            this.pendingKills.set(key, pending)
          },
          clearPendingKill: (key) => {
            this.pendingKills.delete(key)
          }
        },
        registry: {
          getActiveRun: (activeRunId) => this.activeRuns.get(activeRunId),
          assignWorkspace: (activeRunId, workspace) => {
            const activeRun = this.activeRuns.get(activeRunId)
            if (activeRun) activeRun.workspace = workspace
          },
          appendTrace: (traceRunId, entry) => {
            saveTrace(this.activeRuns, traceRunId, entry)
          },
          removeActiveRun: (activeRunId) => {
            this.activeRuns.delete(activeRunId)
          }
        },
        workspaceStore: {
          captureOutputDiff: (diffRunId, saveTraceEntry, notify) =>
            captureRunWorkspaceDiff(
              diffRunId,
              this.activeRuns,
              this.completedRunWorkspaces,
              this.completedRunDiffs,
              saveTraceEntry,
              notify
            ),
          getCompletedDiff: (diffRunId) => this.completedRunDiffs.get(diffRunId) ?? null
        },
        messaging: {
          publish: (message) => {
            return bus.publish(message)
          },
          history: () => bus.history(),
          createChildTools: (childRunId, childAgentName) => createBusTools(bus, childRunId, childAgentName),
          sendReply: async (replyRunId, answer) => {
            if (!this.messageRouter) return
            await this.messageRouter.sendReply(replyRunId, answer)
          },
          dispose: () => {
            bus.dispose()
          }
        },
        bootHostDeps: this.bootHostDeps,
        controller
      },
      sideEffects: {
        runRepo: services.runRepo,
        auditLog: services.auditService,
        eventBus: services.eventBus,
        policyEvaluator: services.policyEvaluator,
        learner: services.learner
      }
    }
  }

  private async executeRun(command: ExecuteRunCommand): Promise<void> {
    return executeRunImpl(command)
  }
}
