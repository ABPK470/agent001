/**
 * Spawn kernel — the ONE place a child `Agent` is constructed and run.
 *
 * Every delegation path (planner subagent steps today; any future ad-hoc
 * caller) builds a `ChildContract` describing WHAT to run, then calls
 * `spawnChild` to actually run it. The kernel owns the shared Agent
 * lifecycle: queue slot acquisition, trace emission, usage rollup, and
 * the try/catch/finally that always resolves to a `DelegateResult`.
 *
 * Callers (e.g. `spawn-for-plan.ts`) are thin adapters: they translate their
 * own inputs (an `ExecutionEnvelope` + `SubagentTaskStep`, or a raw goal)
 * into a `ChildContract` and hand it to this kernel.
 *
 * @module
 */

import type { DelegateResult } from "../../core/plan.js"
import { Agent } from "../../runtime/agent.js"
import { LLMCallPhase } from "../../domain/enums/llm.js"
import { DelegationSpanEventKind, DelegationTraceKind } from "../../domain/enums/planner-trace.js"
import type { Tool } from "../../domain/types/agent-types.js"
import type { DelegateContext } from "../delegate/index.js"
import { buildChildExecutionResult } from "./helpers.js"
import { runWithPlannerStep } from "./planner-step-scope.js"

/**
 * Everything the kernel needs to run one child agent to completion.
 * Built by an adapter (e.g. `spawnChildForPlan`) from its own inputs.
 */
export interface ChildContract {
  readonly goal: string
  readonly childRunId: string
  readonly childAgentName: string
  readonly tools: Tool[]
  readonly maxIterations: number
  readonly systemPrompt: string
  readonly completionValidator?: () => Promise<string | null>
  readonly deferRecoveryHintsUntilCompletionAttempt?: boolean
  /** Trace shape — distinguishes planner-step spans from generic ones and carries their labels. */
  readonly trace: {
    readonly kind: "adhoc" | "planner"
    readonly stepName?: string
    /** Short human label for the start-span trace event. Defaults to `goal` when omitted. */
    readonly goal?: string
    readonly budget?: unknown
    readonly envelope?: unknown
  }
}

/** Trace-kind triples for the two spans the kernel can emit. */
const TRACE_KINDS = {
  adhoc: {
    start: DelegationTraceKind.Start,
    iteration: DelegationTraceKind.Iteration,
    end: DelegationTraceKind.End
  },
  planner: {
    start: DelegationTraceKind.PlannerStart,
    iteration: DelegationTraceKind.PlannerIteration,
    end: DelegationTraceKind.PlannerEnd
  }
} as const

export async function spawnChild(ctx: DelegateContext, contract: ChildContract): Promise<DelegateResult> {
  const { childRunId, childAgentName, trace, maxIterations } = contract
  const kinds = TRACE_KINDS[trace.kind]
  const isPlanner = trace.kind === "planner"

  ctx.onChildTrace?.({
    kind: kinds.start,
    goal: trace.goal ?? contract.goal,
    stepName: trace.stepName,
    depth: ctx.depth + 1,
    tools: contract.tools.map((t) => t.name),
    ...(isPlanner ? { budget: trace.budget, envelope: trace.envelope } : {})
  })

  let releaseSlot: (() => void) | undefined
  if (ctx.acquireSlot) {
    releaseSlot = await ctx.acquireSlot(childRunId)
  }

  let pendingLlmEvents: Record<string, unknown>[] = []

  const child = new Agent(ctx.llm, contract.tools, {
    maxIterations,
    systemPrompt: contract.systemPrompt,
    verbose: false,
    signal: ctx.signal,
    deferRecoveryHintsUntilCompletionAttempt: contract.deferRecoveryHintsUntilCompletionAttempt,
    completionValidator: contract.completionValidator,
    onThinking: (content, toolCalls, iteration) => {
      ctx.onChildTrace?.({
        kind: kinds.iteration,
        stepName: trace.stepName,
        depth: ctx.depth + 1,
        iteration: iteration + 1,
        maxIterations,
        toolNames: toolCalls.map((c) => c.name),
        content: content ? content.slice(0, 200) : null
      })
      for (const ev of pendingLlmEvents) ctx.onChildTrace?.(ev)
      pendingLlmEvents = []
      if (!isPlanner && content) {
        ctx.onChildTrace?.({
          kind: DelegationSpanEventKind.Thinking,
          text: `[D${ctx.depth + 1}] ${content.slice(0, 500)}`
        })
      }
      ctx.onChildUsage?.(child.usage, child.llmCalls)
      ctx.onChildIteration?.({
        childRunId,
        childAgentName,
        iteration: iteration + 1,
        maxIterations,
        content: content ? content.slice(0, 200) : null,
        toolNames: toolCalls.map((c) => c.name)
      })
    },
    onStep: () => {
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onNudge: (data) => {
      ctx.onChildTrace?.({
        kind: DelegationSpanEventKind.Nudge,
        tag: `[${trace.stepName ?? `D${ctx.depth + 1}`}] ${data.tag}`,
        message: data.message,
        iteration: data.iteration
      })
    },
    onLlmCall: (data) => {
      if (data.phase === LLMCallPhase.Request) {
        pendingLlmEvents.push({
          kind: DelegationSpanEventKind.LlmRequest,
          iteration: data.iteration,
          messageCount: data.messages.length,
          toolCount: data.tools.length,
          messages: data.messages.map((m) => ({
            role: m.role,
            content: m.content,
            toolCalls:
              m.toolCalls?.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) ?? [],
            toolCallId: m.toolCallId ?? null
          }))
        })
      } else {
        pendingLlmEvents.push({
          kind: DelegationSpanEventKind.LlmResponse,
          iteration: data.iteration,
          durationMs: data.durationMs,
          content: data.response.content,
          toolCalls:
            data.response.toolCalls?.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments
            })) ?? [],
          usage: data.response.usage ?? null
        })
      }
    }
  })

  try {
    const answer = await (trace.stepName
      ? runWithPlannerStep(trace.stepName, () => child.run(contract.goal))
      : child.run(contract.goal))
    const hitLimit = answer.startsWith("Agent stopped after")

    ctx.onChildUsage?.(child.usage, child.llmCalls)
    ctx.onChildTrace?.({
      kind: kinds.end,
      stepName: trace.stepName,
      depth: ctx.depth + 1,
      status: hitLimit ? "error" : "done",
      answer: answer.slice(0, 500),
      ...(hitLimit ? { error: "Child agent exhausted iteration budget" } : {})
    })

    if (hitLimit) {
      const output = isPlanner
        ? `⚠ DELEGATION INCOMPLETE — child agent for step "${trace.stepName}" used all ${maxIterations} iterations without finishing.\nChild's last output: ${answer}`
        : `⚠ DELEGATION INCOMPLETE — child agent used all ${maxIterations} iterations without finishing.\n` +
          `Child's last output: ${answer}\n` +
          `You MUST either re-delegate with a simpler/clearer goal, or handle this task directly.`
      return { output, toolCalls: child.allToolCalls, execution: buildChildExecutionResult(output, child.allToolCalls) }
    }

    return {
      output: answer,
      toolCalls: child.allToolCalls,
      execution: buildChildExecutionResult(answer, child.allToolCalls)
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)

    ctx.onChildTrace?.({
      kind: kinds.end,
      stepName: trace.stepName,
      depth: ctx.depth + 1,
      status: "error",
      error: errMsg
    })

    const output = `Delegation failed: ${errMsg}`
    return { output, toolCalls: child.allToolCalls, execution: buildChildExecutionResult(output, child.allToolCalls) }
  } finally {
    releaseSlot?.()
  }
}
