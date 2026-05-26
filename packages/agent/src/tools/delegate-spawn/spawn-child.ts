import { Agent } from "../../agent/index.js"
import { READ_ONLY_TOOL_NAMES } from "../../domain/agent-constants.js"
import { LLMCallPhase } from "../../domain/enums/llm.js"
import { DelegationSpanEventKind, DelegationTraceKind } from "../../domain/enums/planner-trace.js"
import type { Tool } from "../../types.js"
import { CHILD_SYSTEM_PROMPT, type DelegateContext, type ResolvedAgent } from "../delegate/index.js"
import type { ChildSpec } from "./helpers.js"

const DEFAULT_CHILD_ITERATIONS = 50
const MAX_CHILD_ITERATIONS = 180

export async function spawnChild(ctx: DelegateContext, spec: ChildSpec): Promise<string> {
  const maxIter = Math.min(spec.maxIterations ?? DEFAULT_CHILD_ITERATIONS, MAX_CHILD_ITERATIONS)

  // Resolve named agent definition
  let resolvedAgent: ResolvedAgent | null = null
  if (spec.agentId && ctx.resolveAgent) {
    resolvedAgent = ctx.resolveAgent(spec.agentId)
    if (!resolvedAgent) {
      return `Delegation failed: agent "${spec.agentId}" not found.`
    }
  }

  // Resolve tools: named agent's tools > explicit tool list > all tools
  let childTools: Tool[]
  let childPrompt: string | undefined
  // Note appended to the child's system prompt to inform it of read-only tools
  // it has access to but might not have considered. Built when we auto-expand
  // an over-restrictive read-only whitelist (Fix B / Fix C).
  let toolBundleNote: string | undefined

  if (resolvedAgent) {
    childTools = resolvedAgent.tools.filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")
    childPrompt = resolvedAgent.systemPrompt
  } else if (spec.tools && spec.tools.length > 0) {
    const requested = new Set(spec.tools)
    // Fix B: if every requested tool is read-only, auto-expand to include the
    // full read-only bundle. The parent often over-restricts (e.g. tools=["inspect_definition"])
    // which leaves the child stuck if its first choice is insufficient — it
    // can't even SEE that other tools exist. Adding sibling read-only tools
    // is risk-free (they have no side effects) and gives the child an escape
    // hatch for self-recovery.
    const allRequestedAreReadOnly = [...requested].every((name) => READ_ONLY_TOOL_NAMES.has(name))
    let effectiveRequested = requested
    if (allRequestedAreReadOnly) {
      effectiveRequested = new Set(requested)
      for (const t of ctx.availableTools) {
        if (READ_ONLY_TOOL_NAMES.has(t.name)) effectiveRequested.add(t.name)
      }
      const added = [...effectiveRequested].filter((n) => !requested.has(n))
      if (added.length > 0) {
        // Fix C: tell the child these adjacent tools exist so it knows the
        // escape hatch is available.
        toolBundleNote =
          `\n\n--- Available read-only tools ---\n` +
          `Your task was scoped to: ${[...requested].join(", ")}.\n` +
          `For self-recovery (if your primary tool is insufficient), you ALSO have access to ` +
          `these read-only tools: ${added.join(", ")}.\n` +
          `Use them only if needed — start with your scoped tools first.`
      }
    }
    childTools = ctx.availableTools.filter(t => effectiveRequested.has(t.name))
  } else {
    childTools = ctx.availableTools.filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")
  }

  // Children are workers — no delegation tools. Just their execution tools.
  childTools = childTools.filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")

  // Each spawned child gets its OWN run id so bus messages, telemetry, and
  // queue slots can be attributed to the actual publisher rather than the
  // parent. Generated unconditionally (the older code only generated this
  // inside `if (ctx.acquireSlot)`, which left the bus / iteration hook
  // without an identity for unqueued runs).
  const childRunId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const childAgentName = resolvedAgent?.name ?? "Child Agent"

  // Inject extra tools (e.g., bus messaging tools).
  // Two paths, in priority order:
  //  1. `buildChildTools(childRunId, childAgentName)` — preferred. Used by
  //     the orchestrator to mint per-child bus tools so each child publishes
  //     under its OWN identity (Phase B.3).
  //  2. `extraChildTools` — legacy/static. A flat list of tools shared
  //     across all children. Tools from path (1) override same-named ones
  //     from path (2).
  const builtPerChild = ctx.buildChildTools ? ctx.buildChildTools(childRunId, childAgentName) : []
  const builtPerChildNames = new Set(builtPerChild.map(t => t.name))
  if (ctx.extraChildTools) {
    const extraNames = new Set(ctx.extraChildTools.map(t => t.name))
    childTools = [
      ...childTools.filter(t => !extraNames.has(t.name) && !builtPerChildNames.has(t.name)),
      ...ctx.extraChildTools.filter(t => !builtPerChildNames.has(t.name)),
      ...builtPerChild,
    ]
  } else if (builtPerChild.length > 0) {
    childTools = [
      ...childTools.filter(t => !builtPerChildNames.has(t.name)),
      ...builtPerChild,
    ]
  }

  ctx.onChildTrace?.({
    kind: DelegationTraceKind.Start,
    goal: spec.goal,
    depth: ctx.depth + 1,
    tools: childTools.map(t => t.name),
    ...(resolvedAgent ? { agentId: resolvedAgent.id, agentName: resolvedAgent.name } : {}),
  })

  // Optionally acquire a queue slot using the same child run id we just
  // generated, so the queue and the bus see the child as one entity.
  let releaseSlot: (() => void) | undefined
  if (ctx.acquireSlot) {
    releaseSlot = await ctx.acquireSlot(childRunId)
  }

  // Always use CHILD_SYSTEM_PROMPT as the behavioral base.
  // If the parent provided its resolved system prompt (containing DB knowledge, schema
  // context, tool usage rules, etc.) prepend it so the child is not "blind".
  const basePrompt = ctx.parentSystemPrompt
    ? `${ctx.parentSystemPrompt}\n\n---\n\n${CHILD_SYSTEM_PROMPT}`
    : CHILD_SYSTEM_PROMPT
  const withAgentPrompt = childPrompt
    ? `${basePrompt}\n\n--- Agent-specific instructions ---\n${childPrompt}`
    : basePrompt
  const effectivePrompt = toolBundleNote
    ? `${withAgentPrompt}${toolBundleNote}`
    : withAgentPrompt

  const effectiveGoal = spec.instructions
    ? `${spec.goal}\n\nAdditional instructions:\n${spec.instructions}`
    : spec.goal

  // Buffer LLM request/response events so they emit AFTER the iteration marker
  let pendingLlmEvents: Record<string, unknown>[] = []

  const child = new Agent(ctx.llm, childTools, {
    maxIterations: maxIter,
    systemPrompt: effectivePrompt,
    verbose: false,
    signal: ctx.signal,
    onThinking: (content, _toolCalls, iteration) => {
      ctx.onChildTrace?.({
        kind: DelegationTraceKind.Iteration,
        depth: ctx.depth + 1,
        iteration: iteration + 1,
        maxIterations: maxIter,
      })
      for (const ev of pendingLlmEvents) ctx.onChildTrace?.(ev)
      pendingLlmEvents = []
      if (content) {
        ctx.onChildTrace?.({
          kind: DelegationSpanEventKind.Thinking,
          text: `[D${ctx.depth + 1}] ${content.slice(0, 500)}`,
        })
      }
      ctx.onChildUsage?.(child.usage, child.llmCalls)
      // Phase B.3: notify the orchestrator of the iteration boundary so it
      // can auto-publish a Status to the bus on this child's behalf. The
      // hook is fired EVERY iteration; throttling (e.g. every Nth) is the
      // orchestrator's responsibility.
      ctx.onChildIteration?.({
        childRunId,
        childAgentName,
        iteration: iteration + 1,
        maxIterations: maxIter,
        content: content ? content.slice(0, 200) : null,
        toolNames: _toolCalls.map((c) => c.name),
      })
    },
    onStep: (_messages, _iteration) => {
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onNudge: (data) => {
      ctx.onChildTrace?.({
        kind: DelegationSpanEventKind.Nudge,
        tag: `[D${ctx.depth + 1}] ${data.tag}`,
        message: data.message,
        iteration: data.iteration,
      })
    },
    onLlmCall: (data) => {
      if (data.phase === LLMCallPhase.Request) {
        pendingLlmEvents.push({
          kind: DelegationSpanEventKind.LlmRequest,
          iteration: data.iteration,
          messageCount: data.messages.length,
          toolCount: data.tools.length,
          messages: data.messages.map(m => ({
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls?.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) ?? [],
            toolCallId: m.toolCallId ?? null,
          })),
        })
      } else {
        pendingLlmEvents.push({
          kind: DelegationSpanEventKind.LlmResponse,
          iteration: data.iteration,
          durationMs: data.durationMs,
          content: data.response.content,
          toolCalls: data.response.toolCalls?.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) ?? [],
          usage: data.response.usage ?? null,
        })
      }
    },
  })

  try {
    const answer = await child.run(effectiveGoal)
    const hitLimit = answer.startsWith("Agent stopped after")

    ctx.onChildUsage?.(child.usage, child.llmCalls)
    ctx.onChildTrace?.({
      kind: DelegationTraceKind.End,
      depth: ctx.depth + 1,
      status: hitLimit ? "error" : "done",
      answer: answer.slice(0, 500),
      ...(hitLimit ? { error: "Child agent exhausted iteration budget" } : {}),
    })

    if (hitLimit) {
      return `⚠ DELEGATION INCOMPLETE — child agent used all ${maxIter} iterations without finishing.\n` +
        `Child's last output: ${answer}\n` +
        `You MUST either re-delegate with a simpler/clearer goal, or handle this task directly.`
    }

    return answer
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)

    ctx.onChildTrace?.({
      kind: DelegationTraceKind.End,
      depth: ctx.depth + 1,
      status: "error",
      error: errMsg,
    })

    return `Delegation failed: ${errMsg}`
  } finally {
    releaseSlot?.()
  }
}
