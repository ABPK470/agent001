/**
 * LOCAL LAPTOP HARNESS — not a product feature. Opt-in via MIA_LOCAL_RUN_SIMULATE=1.
 * Delete packages/server/src/local-harness/ to remove.
 */

import { randomUUID } from "node:crypto"
import { EventType } from "@mia/shared-enums"
import type { TraceEntry } from "@mia/shared-types"
import { broadcast, broadcastTrace } from "../../infra/events/broadcaster.js"
import {
  createThread,
  markRunCancelled,
  saveRun,
  saveTraceEntry,
  touchThread,
} from "../../infra/persistence/adapters/sqlite/index.js"
import { isLocalRunSimulateEnabled } from "./allow.js"
import {
  DEMO_RUN_SCENARIOS,
  isDemoRunPace,
  isDemoRunScenarioId,
  paceDelayMs,
  type DemoRunPace,
  type DemoRunScenarioId,
} from "./demo-run-scenarios.js"

export type SimulateLiveRunInput = {
  scenario: DemoRunScenarioId
  pace?: DemoRunPace
  threadId?: string | null
  upn: string
  displayName: string | null
}

export type SimulateLiveRunResult = {
  runId: string
  threadId: string
  goal: string
  threadTitle: string
}

type ActiveSim = {
  controller: AbortController
  upn: string
}

const activeSims = new Map<string, ActiveSim>()

/**
 * Abort paced playback and settle like a real cancel: persist + SSE immediately.
 * Waiting for the next sleep to unwind left the UI stuck "running".
 */
export async function cancelSimulatedRun(runId: string): Promise<boolean> {
  const active = activeSims.get(runId)
  if (!active) return false
  active.controller.abort()
  // No-op if the row is not created yet (pre-play delay) or already terminal.
  await markRunCancelled(runId)
  broadcast({
    type: EventType.RunCancelled,
    data: { runId, actorUpn: active.upn },
  })
  return true
}

export function isSimulatedRunActive(runId: string): boolean {
  return activeSims.has(runId)
}

function abortError(): Error {
  const err = new Error("aborted")
  err.name = "AbortError"
  return err
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(id)
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function answerFromTrace(trace: TraceEntry[]): string | null {
  for (let i = trace.length - 1; i >= 0; i--) {
    const e = trace[i]!
    if (e.kind === "answer") return e.text
  }
  return null
}

function parseToolArgs(argsFormatted: string | undefined): Record<string, unknown> {
  if (!argsFormatted?.trim()) return {}
  try {
    const v = JSON.parse(argsFormatted) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  } catch (err) {
    console.warn("[local-harness] tool args JSON parse failed", err)
  }
  return {}
}

/** Companion surface events — tools use step.* (client synthesizes tool rows). */
function companionEvents(
  runId: string,
  entry: TraceEntry,
): Array<{ type: string; data: Record<string, unknown> }> {
  switch (entry.kind) {
    case "planner-decision":
      if (entry.shouldPlan || entry.route === "planner") {
        return [{ type: EventType.PlannerStarted, data: { runId, reason: entry.reason } }]
      }
      return []
    case "planner-pipeline-start":
      return [{ type: EventType.PlannerPipelineStarted, data: { runId, attempt: entry.attempt } }]
    case "planner-pipeline-end":
      return [
        {
          type: EventType.PlannerCompleted,
          data: {
            runId,
            status: entry.status,
            completedSteps: entry.completedSteps,
            totalSteps: entry.totalSteps,
          },
        },
      ]
    case "planner-step-start":
      return [
        {
          type: EventType.PlannerStepStarted,
          data: { runId, stepName: entry.stepName, stepType: entry.stepType },
        },
      ]
    case "planner-step-end":
      return [
        {
          type: EventType.PlannerStepCompleted,
          data: {
            runId,
            stepName: entry.stepName,
            status: entry.status,
            durationMs: entry.durationMs,
          },
        },
      ]
    case "thinking":
      return [{ type: EventType.AgentThinking, data: { runId, text: entry.text } }]
    case "delegation-start":
      return [{ type: EventType.DelegationStarted, data: { runId, ...entry } }]
    case "delegation-end":
      return [{ type: EventType.DelegationEnded, data: { runId, ...entry } }]
    case "delegation-iteration":
      return [{ type: EventType.DelegationIteration, data: { runId, ...entry } }]
    case "delegation-parallel-start":
      return [{ type: EventType.DelegationParallelStarted, data: { runId, ...entry } }]
    case "delegation-parallel-end":
      return [{ type: EventType.DelegationParallelEnded, data: { runId, ...entry } }]
    case "user-input-request":
      return [
        {
          type: EventType.UserInputRequired,
          data: {
            runId,
            question: entry.question,
            options: entry.options ?? [],
          },
        },
      ]
    case "user-input-response":
      return [{ type: EventType.UserInputResponse, data: { runId, text: entry.text } }]
    case "usage":
      return [
        {
          type: EventType.UsageUpdated,
          data: {
            runId,
            totalTokens: entry.totalTokens,
            promptTokens: entry.promptTokens,
            completionTokens: entry.completionTokens,
            llmCalls: entry.llmCalls,
          },
        },
      ]
    case "tool-call": {
      const stepId = entry.invocationId ?? entry.toolCallId ?? randomUUID()
      const input = parseToolArgs(entry.argsFormatted)
      return [
        {
          type: EventType.StepStarted,
          data: {
            runId,
            stepId,
            id: stepId,
            name: entry.tool,
            action: entry.tool,
            input,
            // Parallel-safe nest key for chat step-blocks.
            ...(entry.stepName ? { stepName: entry.stepName } : {}),
          },
        },
        {
          type: EventType.ToolCallExecuting,
          data: { runId, toolCallId: entry.toolCallId ?? stepId, tool: entry.tool },
        },
      ]
    }
    case "tool-result": {
      const stepId = entry.invocationId ?? entry.toolCallId ?? randomUUID()
      return [
        {
          type: EventType.StepCompleted,
          data: {
            runId,
            stepId,
            id: stepId,
            output: { result: entry.text },
          },
        },
        {
          type: EventType.ToolCallCompleted,
          data: { runId, toolCallId: entry.toolCallId ?? stepId },
        },
      ]
    }
    case "tool-error": {
      const stepId = entry.invocationId ?? entry.toolCallId ?? randomUUID()
      return [
        {
          type: EventType.StepFailed,
          data: {
            runId,
            stepId,
            id: stepId,
            error: entry.text,
            action: "tool",
          },
        },
        {
          type: EventType.ToolCallCompleted,
          data: { runId, toolCallId: entry.toolCallId ?? stepId },
        },
      ]
    }
    case "sync-progress":
      if (entry.tool === "sync_preview" && entry.status === "done") {
        return [
          {
            type: EventType.SyncAgentPreview,
            data: {
              runId,
              planId: "plan-sim",
              source: "dev",
              target: "uat",
              entityType: "client",
            },
          },
        ]
      }
      return []
    default:
      return []
  }
}

/**
 * Live SSE copy of a persisted entry. Drop tool rows (step.* owns those).
 * Keep system-prompt + full llm-request — Context / Call Sent need them.
 */
function liveWireTrace(entry: TraceEntry): TraceEntry | null {
  // Tools: step.* synthesizes live rows — avoid duplicates.
  if (entry.kind === "tool-call" || entry.kind === "tool-result" || entry.kind === "tool-error") {
    return null
  }
  // run.queued already seeds the goal on the client.
  if (entry.kind === "goal") return null
  return entry
}

/** Kinds chat ignores — don't burn pace budget on dead air before visible work. */
function isChatVisiblePace(entry: TraceEntry): boolean {
  switch (entry.kind) {
    case "system-prompt":
    case "tools-resolved":
    case "tools-filtered":
    case "llm-request":
    case "llm-response":
    case "usage":
    case "planner-runtime-compiled":
    case "iteration":
    case "planner-sql-quality":
      return false
    default:
      return true
  }
}

async function persistTerminal(
  runId: string,
  opts: {
    goal: string
    status: "completed" | "failed" | "cancelled"
    answer: string | null
    error: string | null
    stepCount: number
    threadId: string
    upn: string
    displayName: string | null
    createdAt: string
  },
): Promise<void> {
  await saveRun({
    id: runId,
    goal: opts.goal,
    status: opts.status,
    answer: opts.answer,
    step_count: opts.stepCount,
    error: opts.error,
    parent_run_id: null,
    created_at: opts.createdAt,
    completed_at: new Date().toISOString(),
    thread_id: opts.threadId,
    upn: opts.upn,
    display_name: opts.displayName,
  })
}

async function playSimulation(
  runId: string,
  threadId: string,
  scenarioId: DemoRunScenarioId,
  pace: DemoRunPace,
  upn: string,
  displayName: string | null,
  signal: AbortSignal,
): Promise<void> {
  const scenario = DEMO_RUN_SCENARIOS[scenarioId]
  const trace = scenario.buildTrace()
  const goal = scenario.goal
  const createdAt = new Date().toISOString()
  let seq = 0
  let stepCount = 0

  try {
    await saveRun({
      id: runId,
      goal,
      status: "pending",
      answer: null,
      step_count: 0,
      error: null,
      parent_run_id: null,
      created_at: createdAt,
      completed_at: null,
      thread_id: threadId,
      upn,
      display_name: displayName,
    })
    await touchThread(threadId)

    broadcast({
      type: EventType.RunQueued,
      data: { runId, goal, threadId, actorUpn: upn, upn },
    })

    // Persist goal (client already has it from run.queued).
    const goalEntry = trace.find((e) => e.kind === "goal")
    if (goalEntry) {
      await saveTraceEntry({
        run_id: runId,
        seq: seq++,
        data: JSON.stringify(goalEntry),
        created_at: new Date().toISOString(),
      })
    }

    await sleep(pace === "fast" ? 80 : pace === "slow" ? 600 : 200, signal)
    await saveRun({
      id: runId,
      goal,
      status: "running",
      answer: null,
      step_count: 0,
      error: null,
      parent_run_id: null,
      created_at: createdAt,
      completed_at: null,
      thread_id: threadId,
      upn,
      display_name: displayName,
    })
    broadcast({ type: EventType.RunStarted, data: { runId, actorUpn: upn } })

    for (const entry of trace) {
      if (signal.aborted) throw abortError()
      if (entry.kind === "goal") continue
      const delay = isChatVisiblePace(entry)
        ? paceDelayMs(pace, entry)
        : pace === "slow"
          ? 36
          : 0
      if (delay > 0) await sleep(delay, signal)
      if (signal.aborted) throw abortError()

      await saveTraceEntry({
        run_id: runId,
        seq: seq++,
        data: JSON.stringify(entry),
        created_at: new Date().toISOString(),
      })

      const wire = liveWireTrace(entry)
      if (wire) {
        broadcastTrace(runId, seq - 1, wire)
      }

      for (const ev of companionEvents(runId, entry)) {
        broadcast({
          type: ev.type as (typeof EventType)[keyof typeof EventType],
          data: { ...ev.data, actorUpn: upn },
        })
      }

      if (entry.kind === "tool-call") stepCount += 1

      if (entry.kind === "answer") {
        const text = entry.text
        const chunkSize = pace === "fast" ? 48 : pace === "slow" ? 12 : 24
        for (let i = 0; i < text.length; i += chunkSize) {
          await sleep(pace === "fast" ? 20 : pace === "slow" ? 135 : 45, signal)
          if (signal.aborted) throw abortError()
          broadcast({
            type: EventType.AnswerChunk,
            data: { runId, chunk: text.slice(i, i + chunkSize), actorUpn: upn },
          })
        }
      }
    }

    if (signal.aborted) throw abortError()
    const answer = answerFromTrace(trace)
    await persistTerminal(runId, {
      goal,
      status: "completed",
      answer,
      error: null,
      stepCount,
      threadId,
      upn,
      displayName,
      createdAt,
    })
    await touchThread(threadId)
    broadcast({
      type: EventType.RunCompleted,
      data: {
        runId,
        answer: answer ?? "",
        status: "completed",
        stepCount,
        actorUpn: upn,
      },
    })
  } catch (err) {
    const aborted =
      signal.aborted || (err instanceof Error && err.name === "AbortError")
    if (aborted) {
      // cancelSimulatedRun already persisted + broadcast eagerly; settle idempotently
      // if abort arrived from sleep before that path (should not), or race.
      await markRunCancelled(runId)
      await touchThread(threadId)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    await persistTerminal(runId, {
      goal,
      status: "failed",
      answer: null,
      error: message,
      stepCount,
      threadId,
      upn,
      displayName,
      createdAt,
    })
    broadcast({
      type: EventType.RunFailed,
      data: { runId, error: message, actorUpn: upn },
    })
    throw err
  } finally {
    activeSims.delete(runId)
  }
}

export async function startSimulatedLiveRun(
  input: SimulateLiveRunInput,
): Promise<SimulateLiveRunResult> {
  if (!isLocalRunSimulateEnabled()) {
    throw new Error("Local run simulate harness is not enabled")
  }
  if (!isDemoRunScenarioId(input.scenario)) {
    throw new Error(`Unknown scenario: ${String(input.scenario)}`)
  }
  const pace: DemoRunPace = isDemoRunPace(input.pace) ? input.pace : "normal"
  const scenario = DEMO_RUN_SCENARIOS[input.scenario]

  let threadId = input.threadId?.trim() || null
  let threadTitle = `Sim — ${scenario.label}`
  if (!threadId) {
    const thread = await createThread(input.upn, threadTitle)
    threadId = thread.id
    threadTitle = thread.title
  } else {
    await touchThread(threadId)
    threadTitle = scenario.label
  }

  const runId = randomUUID()
  const controller = new AbortController()
  activeSims.set(runId, { controller, upn: input.upn })

  // Let the POST response land and the client seed the optimistic run before
  // SSE floods — otherwise early trace events are dropped (no run row yet).
  const signal = controller.signal
  void (async () => {
    try {
      await sleep(120, signal)
      await playSimulation(
        runId,
        threadId,
        input.scenario,
        pace,
        input.upn,
        input.displayName,
        signal,
      )
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        // cancelSimulatedRun already settled SSE; nothing else to emit.
        return
      }
      console.error(`[simulate] run ${runId} failed:`, err)
    } finally {
      activeSims.delete(runId)
    }
  })()

  return { runId, threadId, goal: scenario.goal, threadTitle }
}
