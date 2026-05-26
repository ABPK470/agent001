import {
  Agent,
  cancelRun,
  completeRun,
  computeAutoDetectedExcludeDirs,
  configureAgent,
  createRun,
  detectInternalFailure,
  EventType,
  failRun,
  fillRunReference,
  getCatalog,
  governTool,
  isPlatformUnconfiguredAnswer,
  isUserSafeFailureAnswer,
  makeRunContext,
  mapFailureKindForPolish,
  markPolishedFailure,
  PolicyRole,
  PolicyRunMode,
  polishFailureForUser,
  runCompleted,
  runFailed,
  runStarted,
  spawnChildForPlan,
  startPlanning,
  startRunning,
  SyncRunStatus,
  synthesizeGenericFailureAnswer,
  type AgentHost,
  type DelegateContext,
  type EngineServices,
  type HostedPolicyContext,
  type Message,
  type ResolvedAgent,
  type RunState,
  type Tool,
  type ToolKillManager
} from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { createServerBrowserCredentialProvider } from "../../../adapters/browser/credential-provider.js"
import { createServerBrowserHandoffProvider } from "../../../adapters/browser/handoff-provider.js"
import { createServerBrowserContextProvider } from "../../../adapters/browser/provider.js"
import { resetEffectSeq } from "../../../adapters/effects/index.js"
import { createServerAttachmentService } from "../../../adapters/persistence/attachments.js"
import { consolidate, extractProcedural, ingestAgentNote, ingestRunTurns, listTableVerdicts, lookupToolKnowledge, renderCachedHeader, retrieveContext, saveToolKnowledge } from "../../../adapters/persistence/memory.js"
import * as db from "../../../adapters/persistence/sqlite.js"
import { AgentBus, createBusTools } from "../../../agent-bus.js"
import { AuditActor } from "../../../enums/audit.js"
import { BusProtocol } from "../../../enums/bus.js"
import { NotificationActionType } from "../../../enums/notifications.js"
import { TrajectoryEventKind } from "../../../enums/trajectory.js"
import { broadcast, broadcastTrace, broadcastTraceLoose } from "../../../event-broadcaster.js"
import type { OrchestratorRunCtx } from "../../../ports/orchestration.js"
import { composePerRunTools, getAllTools } from "../../../tools.js"
import { wireEventBroadcasting } from "../../core/coordination/event-wiring.js"
import { handlePlannerTrace } from "../../core/coordination/planner-events.js"
import { runReflectionTurn } from "../../core/coordination/run-reflection.js"
import { loadCandidateVerdicts, loadKnownObjects } from "../../core/data-blocks/known-objects.js"
import { loadPriorResults } from "../../core/data-blocks/prior-results-block.js"
import { loadPriorTurns } from "../../core/data-blocks/prior-turns.js"
import { decideSections, filterToolsByGoal } from "../../core/decide-sections.js"
import { buildSystemMessages } from "../../core/system-messages.js"
import { RunPriority } from "../queue/run-queue.js"
import { prepareRunWorkspace } from "../workspace/run-workspace.js"
import { createNotification, persistAuditLog, persistRun, persistTokenUsage, saveTrace } from "./persistence.js"
import { persistToolResult } from "./tool-result-persister.js"
import { captureRunWorkspaceDiff, wrapWithEffects } from "./workspace-effects.js"

const MSSQL_TOOL_TIMEOUT_MS = 120_000

// ── Tool-gate classification context ──────────────────────────────
//
// The DB-likelihood classifier (`scoreDbLikelihood`) used by the tool
// gate needs to see the conversation, not just the latest user turn.
// Otherwise a short follow-up ("run it", "show me the results") with
// no DB keywords scores 0 and drops query_mssql + 10 other DB tools —
// even when the previous turns are unambiguously data-shaped.
//
// We assemble a bounded text blob from:
//   • the last few user / assistant messages in this session
//     (provides the in-conversation evidence)
//   • working memory + episodic memory (provides cross-session
//     evidence including prior DB tool calls, which scoreDbLikelihood
//     treats as a strong DB signal)
//
// The blob is capped so regex scanning stays O(constant).
const CLASSIFICATION_RECENT_MSGS = 6
const CLASSIFICATION_PER_MSG_CAP = 600

function buildClassificationContext(opts: {
  resumeMessages?: readonly Message[]
  working?: string
  episodic?: string
}): string {
  const parts: string[] = []
  const msgs = opts.resumeMessages ?? []
  // Take the last N user/assistant messages. Tool messages are skipped
  // here — their content (memory tier blob below) is the better signal.
  const recent: string[] = []
  for (let i = msgs.length - 1; i >= 0 && recent.length < CLASSIFICATION_RECENT_MSGS; i--) {
    const m = msgs[i]
    if (!m) continue
    if (m.role !== "user" && m.role !== "assistant") continue
    const text = typeof m.content === "string" ? m.content : ""
    if (!text) continue
    recent.push(text.slice(0, CLASSIFICATION_PER_MSG_CAP))
  }
  if (recent.length > 0) parts.push(recent.reverse().join("\n"))
  if (opts.working)  parts.push(opts.working)
  if (opts.episodic) parts.push(opts.episodic)
  return parts.join("\n")
}

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
  priority: RunPriority = RunPriority.Normal,
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
  const preActiveRun = ctx.activeRuns.get(runId)
  const runWorkspace = await prepareRunWorkspace({ runId, sourceRoot: baseWorkspace, goal, resume: !!resume, role: preActiveRun?.role ?? PolicyRole.Admin })
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
  const runContext = makeRunContext({
    signal: controller.signal,
    memory: {
      writeNote: (payload) => {
        try {
          ingestAgentNote({
            subject: payload.subject,
            claim: payload.claim,
            evidence: payload.evidence,
            category: payload.category,
            sessionId: activeRun?.sessionId ?? null,
            runId,
            upn: activeRun?.ownerUpn ?? null,
          })
        } catch {
          // The writer is a side channel; never let it break a run.
        }
      },
    },
  })

  const ctxRole = activeRun?.role ?? PolicyRole.Admin
  const policyCtx: HostedPolicyContext = {
    runId,
    runMode: ctxRole === PolicyRole.HostedUser ? PolicyRunMode.Hosted : PolicyRunMode.Developer,
    role: ctxRole,
    sandboxRoot: runWorkspace.executionRoot,
    actorUpn: activeRun?.ownerUpn ?? null,
    sessionId: activeRun?.sessionId ?? null,
  }

  // Per-run AgentHost — inherits boot-time port wiring (attachments, browser
  // providers) but overrides workspace / sandbox roots with this run's
  // execution root so isolated sandboxes don't leak across runs. Tools that
  // have been migrated to explicit host/run dependencies (filesystem
  // cluster, search_files, ask_user, attachments, mssql export-tool) close
  // over this host explicitly via their `createXxxTool(host)` factories.
  const perRunHost = configureAgent({
    ...(ctx.bootHostDeps.browserCredentialReader ? { browserCredentialReader: ctx.bootHostDeps.browserCredentialReader } : {}),
    ...(ctx.bootHostDeps.browserHandoffStore ? { browserHandoffStore: ctx.bootHostDeps.browserHandoffStore } : {}),
    ...(ctx.bootHostDeps.shellClient ? { shellClient: ctx.bootHostDeps.shellClient } : {}),
    ...(ctx.bootHostDeps.shellSandboxStrict !== undefined ? { shellSandboxStrict: ctx.bootHostDeps.shellSandboxStrict } : {}),
    ...(ctx.bootHostDeps.browserCheckClient ? { browserCheckClient: ctx.bootHostDeps.browserCheckClient } : {}),
    ...(ctx.bootHostDeps.mssqlDatabases ? { mssqlDatabases: ctx.bootHostDeps.mssqlDatabases } : {}),
    ...(ctx.bootHostDeps.mssqlDefaultConnection ? { mssqlDefaultConnection: ctx.bootHostDeps.mssqlDefaultConnection } : {}),
    ...(ctx.bootHostDeps.catalogInstances ? { catalogInstances: ctx.bootHostDeps.catalogInstances } : {}),
    ...(ctx.bootHostDeps.catalogDefaultCachePath ? { catalogDefaultCachePath: ctx.bootHostDeps.catalogDefaultCachePath } : {}),
    ...(ctx.bootHostDeps.syncState ? { syncState: ctx.bootHostDeps.syncState } : {}),
    attachments: createServerAttachmentService(() => policyCtx),
    browserContextReader: createServerBrowserContextProvider(activeRun?.ownerUpn ?? null),
    browserCredentialReader: createServerBrowserCredentialProvider(activeRun?.ownerUpn ?? null),
    browserHandoffStore: createServerBrowserHandoffProvider(activeRun?.ownerUpn ?? null),
    workspaceRoot: runWorkspace.executionRoot,
    filesystemBasePath: runWorkspace.executionRoot,
    searchFilesBasePath: runWorkspace.executionRoot,
    searchFilesExcludeDirs: new Set(computeAutoDetectedExcludeDirs(runWorkspace.executionRoot)),
    shellCwd: runWorkspace.executionRoot,
    browserCheckCwd: runWorkspace.executionRoot,
    // Per-run toolKnowledge/tableVerdicts adapters — bind upn at construction
    // so tools reading via host.toolKnowledge.{lookup,save} get the run-scoped
    // provenance without any ambient runtime slot.
    toolKnowledge: {
      lookup: (args) => lookupToolKnowledge(args) as unknown as ReturnType<NonNullable<AgentHost["toolKnowledge"]>["lookup"]>,
      save: (args) => saveToolKnowledge({ ...args, upn: activeRun?.ownerUpn ?? null }),
      renderHeader: (hit, opts) => renderCachedHeader(hit as unknown as Parameters<typeof renderCachedHeader>[0], opts),
    },
    tableVerdicts: {
      list: (args) => listTableVerdicts({
        qnames: args.qnames,
        connection: args.connection,
      }),
    },
  })
  const governRuntimeTool = (tool: Tool) => governTool(tool, services, state, {
    signal: controller.signal,
    policyContext: policyCtx,
    ...((tool.name === "query_mssql" || tool.name === "explore_mssql_schema") ? { timeoutMs: MSSQL_TOOL_TIMEOUT_MS } : {}),
  })

  // Goal-shape tool gating. When the goal is clearly not DB- or sync-shaped
  // (decideSections scores 0 on those axes), drop the DB-discovery and sync
  // tools from the registry advertised to the LLM for this run. Without this,
  // their tool schemas alone steer the model into proactive catalog dumps
  // even on trivial conversational turns. See `filterToolsByGoal` for the
  // full policy. The decision is logged once for observability.
  //
  // CRITICAL: classification considers conversation context, not just the
  // latest user message. A short follow-up like "run it" carries zero DB
  // keywords on its own, but the prior turns / memory make it obvious the
  // session is mid-data-task. Without this, every follow-up would drop
  // the very tools the conversation has been using — the "huge gap" gone.
  //
  // Sequence ref for debug-seq on broadcast events. Hoisted so it can be used
  // for early trace emissions (e.g. tools-filtered) before the run loop starts.
  const debugSeqRef = { value: 0 }

  // Build the classification context from anything we already have in hand:
  //   • last N user/assistant messages from `resume?.messages` (the actual
  //     conversation transcript when this is a follow-up turn)
  //   • working & episodic memory tiers retrieved below
  // We retrieve memory up here (moved from later in the function) so the
  // tool gate sees the same evidence the prompt assembler will see. The
  // retrieval is pure — moving it is a no-op for everything downstream
  // beyond the gate that needs it.
  const shouldUseMemory = !(runWorkspace.taskType === "code_generation" && !resume)
  let perTier: { working: string; episodic: string; semantic: string } = { working: "", episodic: "", semantic: "" }
  if (shouldUseMemory) {
    try {
      const result = await retrieveContext(goal, {
        sessionId: activeRun?.sessionId ?? agentId ?? "default",
        runId,
        upn: activeRun?.ownerUpn ?? null,
      })
      perTier = result.perTier
    } catch (memErr) {
      // FTS virtual-table corruption (SQLITE_CORRUPT_VTAB) or other memory errors
      // must not crash the run — continue without injected context.
      console.warn(`[run ${runId}] memory retrieval failed, running without context:`, (memErr as Error).message)
    }
  }

  const classificationContext = buildClassificationContext({
    resumeMessages: resume?.messages,
    working: perTier.working,
    episodic: perTier.episodic,
  })

  const _toolDecision = decideSections({ goal, memory: perTier, context: classificationContext })
  const _toolFilter   = filterToolsByGoal(tools, _toolDecision)
  if (!_toolFilter.passThrough) {
    // eslint-disable-next-line no-console
    console.log(`[tools] run=${runId} dropped ${_toolFilter.dropped.length} DB/sync tools for non-DB goal (kept ${_toolFilter.tools.length}): ${_toolFilter.dropped.join(", ")}`)
    const filteredEntry = {
      kind: TrajectoryEventKind.ToolsFiltered,
      dropped: _toolFilter.dropped,
      kept: _toolFilter.tools.length,
      dbScore: _toolDecision.dbScore ?? 0,
      syncTrigger: !!_toolDecision.triggers?.sync,
      reason: `goal classified non-DB (dbScore=${_toolDecision.dbScore ?? 0}, sync=${!!_toolDecision.triggers?.sync})`,
    } as const
    boundSaveTrace(runId, filteredEntry)
    broadcastTrace(runId, debugSeqRef.value++, filteredEntry)
  }
  const effectiveTools = _toolFilter.tools

  const trackedTools = effectiveTools.map((t) => wrapWithEffects(t, runId, runWorkspace.executionRoot))
  const governedTools = trackedTools.map(governRuntimeTool)

  const maxDelegationDepth = Number(process.env["DELEGATION_MAX_DEPTH"]) || 3
  const agentName = agentId ? (db.getAgentDefinition(agentId)?.name ?? "Agent") : "Universal Agent"
  // Parent's bus tools are added to `allTools` by `composePerRunTools`
  // below (see tools.ts factory list). Children get their OWN bus tools
  // via `delegateCtx.buildChildTools` so messages are attributed to the
  // child run id, not the parent's.

  // Phase B.3: throttle auto-Status to once per N iterations per child to
  // avoid drowning the bus on long runs. Per-child counter so siblings
  // running at different speeds don't share the throttle window.
  const STATUS_THROTTLE = 5
  const lastStatusIter = new Map<string, number>()

  const delegateCtx: DelegateContext = {
    llm: ctx.llm,
    availableTools: governedTools,
    depth: 0,
    maxDepth: maxDelegationDepth,
    signal: controller.signal,
    // Per-child bus tools so each child publishes as ITSELF, not the parent.
    // This is the load-bearing fix for B.3 — without it, every send_message
    // from a delegated child would be persisted with the parent's runId /
    // agentName and siblings would not be able to address each other.
    buildChildTools: (childRunId, childAgentName) => createBusTools(bus, childRunId, childAgentName),
    // Auto-Status: every Nth iteration of every child publishes a Status
    // message so siblings, the parent, and the BusFeed UI see liveness
    // without relying on the model to remember to call send_message.
    onChildIteration: (info) => {
      const last = lastStatusIter.get(info.childRunId) ?? 0
      // Always publish on iteration 1, then every STATUS_THROTTLE iterations.
      if (info.iteration !== 1 && info.iteration - last < STATUS_THROTTLE) return
      lastStatusIter.set(info.childRunId, info.iteration)
      const previewBits: string[] = []
      if (info.toolNames.length > 0) previewBits.push(`tools=[${info.toolNames.join(",")}]`)
      if (info.content) previewBits.push(info.content.replace(/\s+/g, " ").trim())
      const preview = previewBits.join(" ").slice(0, 240)
      try {
        bus.publish({
          topic: `${runId}-status`,
          fromRunId: info.childRunId,
          fromAgent: info.childAgentName,
          content: `iteration ${info.iteration}/${info.maxIterations}${preview ? ": " + preview : ""}`,
          protocol: BusProtocol.Status,
        })
      } catch {
        // Bus publish must never break the agent loop — swallow failures here.
      }
    },
    acquireSlot: (childRunId: string) => ctx.queue.acquire(childRunId, RunPriority.High, controller.signal),
    resolveAgent: (aId: string): ResolvedAgent | null => {
      const def = db.getAgentDefinition(aId)
      if (!def) return null
      const agentTools = getAllTools(perRunHost, runContext).map(governRuntimeTool)
      // resolveAgentSystemPrompt enforces the file-managed contract for the
      // default agent — a child delegation never sees a stale stored value.
      return { id: def.id, name: def.name, systemPrompt: db.resolveAgentSystemPrompt(def), tools: agentTools }
    },
    onChildTrace: (entry) => {
      boundSaveTrace(runId, entry)
      if (entry.kind === TrajectoryEventKind.DelegationStart) {
        broadcast({ type: EventType.DelegationStarted, data: { runId, ...entry } })
        services.auditService.log({ actor: AuditActor.Agent, action: "delegation.started", resourceType: "AgentRun", resourceId: runId, detail: { goal: entry.goal, depth: entry.depth, tools: entry.tools, agentName: entry.agentName } }).catch(() => {})
      } else if (entry.kind === TrajectoryEventKind.DelegationEnd) {
        broadcast({ type: EventType.DelegationEnded, data: { runId, ...entry } })
        services.auditService.log({ actor: AuditActor.Agent, action: entry.status === "done" ? "delegation.completed" : "delegation.failed", resourceType: "AgentRun", resourceId: runId, detail: { depth: entry.depth, status: entry.status, answer: entry.answer, error: entry.error } }).catch(() => {})
      } else if (entry.kind === TrajectoryEventKind.DelegationIteration) {
        broadcast({ type: EventType.DelegationIteration, data: { runId, ...entry } })
      } else if (entry.kind === TrajectoryEventKind.DelegationParallelStart) {
        broadcast({ type: EventType.DelegationParallelStarted, data: { runId, ...entry } })
      } else if (entry.kind === TrajectoryEventKind.DelegationParallelEnd) {
        broadcast({ type: EventType.DelegationParallelEnded, data: { runId, ...entry } })
      } else if (entry.kind === "thinking") {
        broadcast({ type: EventType.AgentThinking, data: { runId, content: entry.text } })
      } else if (typeof entry.kind === "string" && entry.kind.startsWith("planner-delegation")) {
        broadcastTraceLoose(runId, Date.now(), entry as { kind: string } & Record<string, unknown>)
      } else if (entry.kind === "llm-request" || entry.kind === "llm-response" || entry.kind === "nudge") {
        broadcastTraceLoose(runId, Date.now(), entry as { kind: string } & Record<string, unknown>)
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
        broadcast({ type: EventType.UsageUpdated, data: { runId, promptTokens: totalPrompt, completionTokens: totalCompletion, totalTokens, llmCalls: totalLlmCalls } })
      }
    })(),
  }

  // ── Per-run tool composition ──────────────────────────────────────
  // The static tools (governedTools above) are already effect-wrapped and
  // governance-wrapped. The remaining categories — delegate, bus, ask_user
  // — need run-scoped state and are produced by factories registered in
  // `composePerRunTools`. See packages/server/src/tools.ts for the factory
  // list; adding a new category goes there, not here.
  const allToolsBase = composePerRunTools(governedTools, {
    runId,
    agentName,
    bus,
    delegateCtx,
    govern: (tool, opts) => governTool(tool, services, state, { signal: controller.signal, ...(opts ?? {}) }),
    askUserResolve: (question, options, sensitive) => {
      boundSaveTrace(runId, { kind: TrajectoryEventKind.UserInputRequest, question, options, sensitive })
      broadcast({ type: EventType.UserInputRequired, data: { runId, question, options: options ?? [], sensitive } })
      // If this question fuzzy-matches a clarification finding we recently
      // emitted to the agent, stash it as pending so respondToRun() can
      // record the answer as a ResolvedClarification.
      const match = ctx.clarifications.matchQuestion(runId, question)
      if (match) ctx.clarifications.setPending(runId, match, question)
      return new Promise<string>((resolve) => {
        ctx.pendingInputs.set(runId, { resolve })
      })
    },
    // Plumbed to per-run factories that need tenant/session provenance
    // (currently the `note` tool — see PER_RUN_FACTORIES in tools.ts).
    sessionId: activeRun?.sessionId ?? null,
    upn: activeRun?.ownerUpn ?? null,
  })

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
                type: EventType.SyncAgentPreview,
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
          broadcast({ type: EventType.SyncAgentExecuteStarted, data: { runId, planId } })
          const t0 = Date.now()
          const result = await t.execute(args)
          const success = typeof result === "string" && result.toLowerCase().includes("successfully")
          // Also persist finish via db directly, in case executeSync threw before
          // calling getSyncRunSink().finish() internally. INSERT OR REPLACE means
          // if the row already has the correct status from the sink, this is a no-op.
          try {
            db.recordSyncRunFinish({
              planId,
              status: success ? SyncRunStatus.Success : SyncRunStatus.Failed,
              error: success ? null : (typeof result === "string" ? result : null),
              durationMs: Date.now() - t0,
            })
          } catch (e) {
            console.warn("[sync-history] recordSyncRunFinish failed:", e instanceof Error ? e.message : e)
          }
          broadcast({
            type: EventType.SyncAgentExecuteCompleted,
            data: { runId, planId, success, result: typeof result === "string" ? result : String(result) },
          })
          return result
        },
      }
    }
    return t
  })
  resetEffectSeq(runId)

  // Prior turns from the same session, surfaced as a first-class
  // `<prior_turns>` system anchor AND fed to the clarification
  // detector so co-referential follow-ups ("plot it", "filter that")
  // resolve to the previous turn's answer instead of triggering a
  // "which of these did you mean?" question. We skip this for
  // code-generation sandbox runs where the session is a different
  // unit of work (one task per run) and for runs without a real sid.
  // Hoisted so the result is reused by both <prior_turns> and the
  // <known_objects> loader.
  const priorTurnsForRun = (activeRun?.sessionId && activeRun?.ownerUpn && runWorkspace.taskType !== "code_generation")
    ? loadPriorTurns({
        sessionId:    activeRun.sessionId,
        excludeRunId: runId,
        upn:          activeRun.ownerUpn,
        limit:        3,
      })
    : []

  // No-amnesia (Phase 9): pull the structured tool payloads from prior turns
  // in the same session so the model has actual rows to ground on, not just
  // paraphrase. Cheap (single indexed query, capped result count).
  const priorResultsForRun = (activeRun?.sessionId && runWorkspace.taskType !== "code_generation")
    ? loadPriorResults({ sessionId: activeRun.sessionId, excludeRunId: runId })
    : []

  const systemMessages = await buildSystemMessages({
    goal, systemPrompt, allTools, runWorkspace, perTier, runId,
    host: perRunHost,
    attachmentIds: activeRun?.attachmentIds ?? [],
    priorTurns: priorTurnsForRun,
    priorResults: priorResultsForRun,
    // <known_objects> directory — looks at the goal + prior turns,
    // extracts qualified-name candidates, and surfaces matching cached
    // entries from tool_knowledge so the model can prefer the cache
    // path over re-running profile_data / inspect_definition /
    // discover_relationships. Cache-only, never reads MSSQL; empty on
    // first call / cold cache.
    knownObjects: (() => {
      try {
        return loadKnownObjects({ goal, priorTurns: priorTurnsForRun })
      } catch (err) {
        console.warn(`[run ${runId}] knownObjects load failed:`, (err as Error).message)
        return []
      }
    })(),
    // <known_objects> Phase 4 add-on: top-K search_catalog candidates'
    // durable verdicts. Surfaces canonical/subset/staging/archive/rules
    // classifications even when the goal text doesn't name them by
    // qname — closing the read-back loop introduced in Plan v3.
    knownVerdicts: (() => {
      try {
        return loadCandidateVerdicts({
          goal,
          catalog: getCatalog(perRunHost),
          upn: activeRun?.ownerUpn ?? null,
        })
      } catch (err) {
        console.warn(`[run ${runId}] knownVerdicts load failed:`, (err as Error).message)
        return []
      }
    })(),
    // Per-run clarification state lives on the orchestrator. Passing it
    // here lets buildSystemMessages run the ambiguity detectors against
    // the goal + catalog + tenant, record what it emitted so the
    // matching ask_user question can be tied back to a finding, and
    // surface any prior resolved clarifications.
    clarifications: ctx.clarifications,
    llmForClarification: ctx.llm,
    onClarificationTrace: (event) => {
      if (event.kind === "detected") {
        boundSaveTrace(runId, {
          kind: TrajectoryEventKind.ClarificationDetected,
          findingId: event.finding.id,
          ambiguityKind: event.finding.kind,
          severity: event.finding.severity,
          subject: event.finding.subject,
          source: event.finding.source,
          suggestedQuestion: event.finding.suggestedQuestion,
        } as unknown as Record<string, unknown>)
      } else {
        boundSaveTrace(runId, {
          kind: TrajectoryEventKind.ClarificationLlmPlannerInvoked,
          findingsCount: event.findingsCount,
        } as unknown as Record<string, unknown>)
      }
    },
    // Workspace path and home directory are injected only for admin sessions.
    // The role is captured at startRun/resumeRun before the session ALS expires.
    isAdmin: (activeRun?.role ?? PolicyRole.HostedUser) === PolicyRole.Admin,
    // Bus-coordination prompt block triggers when this run is delegated
    // (parent run id present) OR when the run tree's bus already has
    // history (e.g. a sibling has been publishing while we queued).
    // The digest is the most recent ~6 messages, formatted compactly so
    // the agent can scan it at a glance.
    hasSiblings: !!resume?.parentRunId || bus.history().length > 0,
    siblingProgressDigest: (() => {
      // Hard caps so this section cannot blow up under a chatty bus:
      //   - last 6 messages only (oldest fall off)
      //   - each line truncated to 240 chars
      // <sibling_progress> rides in `system_runtime` which is already
      // droppable under token pressure (see DROP_PRIORITY in the
      // agent domain types), so this is the second line of
      // defence, not the primary one.
      const recent = bus.history().slice(-6)
      if (recent.length === 0) return ""
      return recent
        .map((m) => {
          const line = `- [${m.fromAgent}] (${m.protocol}, ${m.topic}): ${m.content}`
          return line.length > 240 ? line.slice(0, 237) + "..." : line
        })
        .join("\n")
    })(),
    // Conventional topic for sibling chatter under this parent. Matches
    // the topic used by the auto-Status hook so a child's Status/Question/
    // Answer/Broadcast all flow through one channel siblings can subscribe
    // to. Phase B.3.
    coordinationTopic: `${runId}-status`,
  })
  const effectivePrompt = systemMessages.map((m) => m.content).join("\n\n")

  // Pass the fully-resolved system prompt (includes DB knowledge, schema context, tool rules,
  // memory tiers) down to all child agents. Without this, children are completely "blind" —
  // they see only CHILD_SYSTEM_PROMPT and have no knowledge of the database or domain tools.
  delegateCtx.parentSystemPrompt = effectivePrompt

  const systemPromptEntry = { kind: TrajectoryEventKind.SystemPrompt, text: effectivePrompt ?? "(no system prompt)" }
  boundSaveTrace(runId, systemPromptEntry)
  broadcastTrace(runId, debugSeqRef.value++, systemPromptEntry)

  const toolsResolvedEntry = { kind: TrajectoryEventKind.ToolsResolved, tools: allTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }
  boundSaveTrace(runId, toolsResolvedEntry)
  broadcastTrace(runId, debugSeqRef.value++, toolsResolvedEntry)

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
        runContext.signal = composed
        return new Promise<string>((resolve) => {
          const key = `${runId}:${toolCallId}`
          ctx.pendingKills.set(key, { resolve, perToolCtrl })
          broadcast({ type: EventType.ToolCallExecuting, data: { runId, toolCallId, toolName } })
        })
      },
      unregister: (toolCallId: string) => {
        callSignals.delete(toolCallId)
        ctx.pendingKills.delete(`${runId}:${toolCallId}`)
        runContext.signal = controller.signal
        broadcast({ type: EventType.ToolCallCompleted, data: { runId, toolCallId } })
      },
      wrap: <T,>(toolCallId: string, fn: () => Promise<T>): Promise<T> => {
        void toolCallId
        return fn()
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
    onPlannerTrace: (entry) => handlePlannerTrace(entry, { runId, services, debugSeqRef, saveTrace: boundSaveTrace }),
    plannerDelegateFn: (step, envelope) => spawnChildForPlan(delegateCtx, step, envelope),
    onNudge: (data) => {
      const entry = { kind: "nudge" as const, tag: data.tag, message: data.message, iteration: data.iteration }
      boundSaveTrace(runId, entry)
      broadcastTrace(runId, debugSeqRef.value++, entry)
    },
    onToolResult: (data) => {
      // No-amnesia hook (Phase 9): persist structured tool payloads so a
      // later turn in the same session can ground on the actual rows
      // instead of paraphrase. Filtered + capped inside the persister.
      persistToolResult({
        runId,
        sessionId: activeRun?.sessionId ?? null,
        upn: activeRun?.ownerUpn ?? null,
        goal,
        iteration: data.iteration,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        args: data.args,
        result: data.result,
        isError: data.isError,
      })
    },
    onLlmCall: (data) => {
      if (data.phase === "request") {
        const entry = { kind: TrajectoryEventKind.LlmRequest, iteration: data.iteration, messageCount: data.messages.length, toolCount: data.tools.length, messages: data.messages.map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls?.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) ?? [], toolCallId: m.toolCallId ?? null })) }
        boundSaveTrace(runId, entry)
        broadcastTrace(runId, debugSeqRef.value++, entry)
      } else {
        const entry = { kind: TrajectoryEventKind.LlmResponse, iteration: data.iteration, durationMs: data.durationMs, content: data.response.content, toolCalls: data.response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })), usage: data.response.usage ?? null }
        boundSaveTrace(runId, entry)
        broadcastTrace(runId, debugSeqRef.value++, entry)
      }
    },
    onThinking: (content, _toolCalls, iteration) => {
      const iterEntry = { kind: TrajectoryEventKind.Iteration, current: iteration + 1, max: 30 }
      boundSaveTrace(runId, iterEntry)
      broadcastTrace(runId, debugSeqRef.value++, iterEntry)
      if (content) {
        boundSaveTrace(runId, { kind: TrajectoryEventKind.Thinking, text: content })
        broadcast({ type: EventType.AgentThinking, data: { runId, content, iteration } })
      }
      const iterationTokens = agent.usage.totalTokens - prevTotalTokens
      prevTotalTokens = agent.usage.totalTokens
      const usageEntry = { kind: TrajectoryEventKind.Usage, iterationTokens, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls }
      boundSaveTrace(runId, usageEntry)
      broadcastTrace(runId, debugSeqRef.value++, usageEntry)
      broadcast({ type: EventType.UsageUpdated, data: { runId, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, totalTokens: agent.usage.totalTokens, llmCalls: agent.llmCalls } })
    },
    onStep: (messages, iteration) => {
      lastMessages = messages
      lastIteration = iteration
      db.saveCheckpoint({ run_id: runId, messages: JSON.stringify(messages), iteration, step_counter: state.stepCounter, updated_at: new Date().toISOString() })
      broadcast({ type: EventType.CheckpointSaved, data: { runId, iteration, stepCounter: state.stepCounter } })
      persistRun(run, goal, agentId, resume?.parentRunId)
    },
    onToken: (token) => {
      broadcast({ type: EventType.AnswerChunk, data: { runId, chunk: token } })
    },
    onStreamDiscard: () => {
      broadcast({ type: EventType.StreamReset, data: { runId } })
    },
  })

  try {
    let answer = await agent.run(
      goal,
      resume ? { messages: resume.messages, iteration: resume.iteration } : undefined,
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
        broadcast({ type: EventType.RunUserSafeFailure, data: { runId, kind: internalFailure.kind, summary: internalFailure.summary } })
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
      broadcast({ type: EventType.RunCancelled, data: { runId, status: RunStatus.Cancelled, stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })
      db.saveLog({ run_id: runId, level: "run:error", message: "Cancelled", timestamp: new Date().toISOString() })
      createNotification({ type: EventType.RunCancelled, title: "Run cancelled", message: `"${goal.slice(0, 80)}" was cancelled after ${run.steps.length} steps.`, runId, actions: [{ label: "View", action: NotificationActionType.ViewRun, data: { runId } }, { label: "Rollback", action: NotificationActionType.RollbackRun, data: { runId } }] })
      return
    }

    // Plan v3 Phase 5 — post-run reflection. Fires only on data-shaped
    // goals (decideSections.includeDataPersona) AND when the answer
    // looks like a normal completion (not failure-flavoured). A single
    // LLM call with one tool (record_table_verdict) cap of 2 tool
    // invocations. Best-effort; failures are logged and swallowed so
    // they cannot affect the user-visible run outcome.
    if (
      _toolDecision.includeDataPersona
      && !isPlatformUnconfiguredAnswer(answer)
      && !detectInternalFailure(answer)
    ) {
      try {
        const verdictTool = allTools.find((t) => t.name === "record_table_verdict")
        if (verdictTool) {
          const reflection = await runReflectionTurn({
            runId,
            goal,
            answer,
            steps: run.steps,
            recordVerdictTool: verdictTool,
            llm: ctx.llm,
            signal: controller.signal,
          })
          // eslint-disable-next-line no-console
          console.log(
            `[reflection] run=${runId} outcome=${reflection.outcome} ` +
            `recorded=${reflection.verdictsRecorded} ${reflection.detail}`,
          )
          // Gap 2: persist the reflection result so it's visible in
          // trace_entries / SEE alongside iterations and tool calls.
          // Without this, the only post-run visibility into whether the
          // reflection fired (and what it decided) is the docker stdout
          // log — which is unhelpful for diagnosing why verdicts aren't
          // being written. The entry is purely observational; it does
          // not change run status.
          boundSaveTrace(runId, {
            kind: "reflection",
            outcome: reflection.outcome,
            verdictsRecorded: reflection.verdictsRecorded,
            toolResults: reflection.toolResults,
            detail: reflection.detail,
          })
        } else {
          boundSaveTrace(runId, {
            kind: "reflection",
            outcome: "skipped",
            verdictsRecorded: 0,
            toolResults: [],
            detail: "record_table_verdict tool not bound to this run",
          })
        }
      } catch (err) {
        console.warn(`[reflection] run=${runId} failed: ${(err as Error).message}`)
        boundSaveTrace(runId, {
          kind: "reflection",
          outcome: "error",
          verdictsRecorded: 0,
          toolResults: [],
          detail: `threw: ${(err as Error).message}`,
        })
      }
    } else {
      // Gap 2: also record the gated-out case so we can tell the
      // difference between "ran and produced no-update" and "never
      // fired" when auditing trace_entries.
      boundSaveTrace(runId, {
        kind: "reflection",
        outcome: "gated",
        verdictsRecorded: 0,
        toolResults: [],
        detail:
          `gate: includeDataPersona=${_toolDecision.includeDataPersona ? 1 : 0} ` +
          `platformUnconfigured=${isPlatformUnconfiguredAnswer(answer) ? 1 : 0} ` +
          `internalFailure=${detectInternalFailure(answer) ? 1 : 0}`,
      })
    }

    completeRun(run)
    await services.eventBus.publish(runCompleted(run.id))
    await services.auditService.log({ actor, action: "agent.completed", resourceType: "AgentRun", resourceId: run.id, detail: { goal, answer: answer.slice(0, 500), totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })

    persistRun(run, goal, agentId, resume?.parentRunId, answer)
    await persistAuditLog(services, runId)
    persistTokenUsage(runId, agent)

    boundSaveTrace(runId, { kind: TrajectoryEventKind.Answer, text: answer })
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
    ingestRunTurns({ id: runId, goal, answer: taskInternallyFailed ? null : answer, status: taskInternallyFailed ? RunStatus.Failed : RunStatus.Completed, agentId, sessionId: activeRun?.sessionId ?? null, tools: [...new Set(run.steps.map((s) => s.action))], stepCount: run.steps.length, error: taskInternallyFailed ? answer.slice(0, 200) : undefined, trace: persistedToolTrace, upn: activeRun?.ownerUpn ?? null })
    extractProcedural({ id: runId, goal, trace: persistedToolTrace, upn: activeRun?.ownerUpn ?? null, sessionId: activeRun?.sessionId ?? null })
    consolidate({ minAgeHours: 24, upn: activeRun?.ownerUpn ?? null })

    broadcast({ type: EventType.RunCompleted, data: { runId, answer, status: RunStatus.Completed, stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls, pendingWorkspaceChanges: pendingChangeCount } })
    db.saveLog({ run_id: runId, level: "run", message: `Completed — ${run.steps.length} steps`, timestamp: new Date().toISOString() })
    createNotification({ type: EventType.RunCompleted, title: "Run completed", message: pendingChangeCount > 0 ? `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps. ${pendingChangeCount} workspace changes pending approval.` : `"${goal.slice(0, 80)}" finished with ${run.steps.length} steps.`, runId, actions: [{ label: "View", action: NotificationActionType.ViewRun, data: { runId } }] })

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
      broadcast({ type: EventType.CheckpointSaved, data: { runId, iteration: lastIteration, stepCounter: state.stepCounter } })
    }

    persistRun(run, goal, agentId, resume?.parentRunId, undefined, errMsg)
    await persistAuditLog(services, runId)
    persistTokenUsage(runId, agent)

    boundSaveTrace(runId, { kind: TrajectoryEventKind.Error, text: errMsg })
    await captureRunWorkspaceDiff(runId, ctx.activeRuns, ctx.completedRunWorkspaces, ctx.completedRunDiffs, boundSaveTrace, createNotification)

    ingestRunTurns({ id: runId, goal, answer: null, status: RunStatus.Failed, agentId, sessionId: activeRun?.sessionId ?? null, tools: [...new Set(run.steps.map((s) => s.action))], stepCount: run.steps.length, error: errMsg, trace: persistedToolTrace, upn: activeRun?.ownerUpn ?? null })

    broadcast({ type: EventType.RunFailed, data: { runId, error: errMsg, stepCount: run.steps.length, totalTokens: agent.usage.totalTokens, promptTokens: agent.usage.promptTokens, completionTokens: agent.usage.completionTokens, llmCalls: agent.llmCalls } })
    db.saveLog({ run_id: runId, level: "run:error", message: `Failed — ${errMsg.slice(0, 200)}`, timestamp: new Date().toISOString() })
    const hasCheckpoint = !!db.getCheckpoint(runId)
    createNotification({ type: EventType.RunFailed, title: "Run failed", message: `"${goal.slice(0, 80)}" failed: ${errMsg.slice(0, 120)}`, runId, actions: [{ label: "Review", action: NotificationActionType.ViewRun, data: { runId } }, ...(hasCheckpoint ? [{ label: "Resume", action: NotificationActionType.ResumeRun, data: { runId } }] : []), { label: "Rollback", action: NotificationActionType.RollbackRun, data: { runId } }] })
  } finally {
    releaseSlot()
    bus.dispose()
    ctx.pendingInputs.delete(runId)
    ctx.activeRuns.delete(runId)
  }
}
