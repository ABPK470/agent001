/**
 * Delegate tools — sub-agent spawning (sequential and parallel).
 *
 * This is the core of true agentic delegation. Two tools:
 *
 *   delegate          — spawn ONE child agent, wait for its answer (sequential)
 *   delegate_parallel — spawn MULTIPLE children concurrently, collect all answers
 *
 * Both tools create ephemeral child agents that:
 *   - Have their own iteration loop and tool set
 *   - Share the parent's abort signal (cancel propagates down)
 *   - Do NOT delegate further — only the root orchestrator delegates (flat hierarchy)
 *   - Get optional inter-agent messaging tools if a bus is provided
 *   - Are governed by the same policy layer
 *
 * Verification pattern:
 *   The parent agent is instructed to verify delegation results and can
 *   re-delegate with feedback if the output doesn't meet expectations.
 *   Max retries are capped per task to prevent infinite rework loops.
 *
 * Why parallel matters:
 *   In multi-agent orchestration, the parent often decomposes work into
 *   independent pieces (research + implementation, or analyze-3-files).
 *   Running these sequentially wastes time. delegate_parallel runs them
 *   concurrently with Promise.allSettled so one failure doesn't kill the rest.
 */

import { Agent } from "../agent.js"
import type { LLMClient, TokenUsage, Tool } from "../types.js"

/** Default iteration budget for a child agent. */
const DEFAULT_CHILD_ITERATIONS = 15

/** Resolved agent definition — minimal shape the delegate tool needs. */
export interface ResolvedAgent {
  id: string
  name: string
  systemPrompt: string
  tools: Tool[]
}

export interface DelegateContext {
  /** LLM client shared across the delegation tree. */
  llm: LLMClient
  /** All tools available in the current run (already governed). */
  availableTools: Tool[]
  /** Current delegation depth (0 = top-level agent). */
  depth: number
  /** Maximum delegation depth. Default: 3 */
  maxDepth?: number
  /** Abort signal from the root run. */
  signal?: AbortSignal
  /** Resolve a named agent definition by ID. Returns null if not found. */
  resolveAgent?: (agentId: string) => ResolvedAgent | null
  /** Called when child agent produces trace events for nesting. */
  onChildTrace?: (entry: Record<string, unknown>) => void
  /** Called when child agent completes a step (for token rollup). */
  onChildUsage?: (usage: TokenUsage, llmCalls: number) => void
  /** Extra tools to inject into every child (e.g., bus messaging tools). */
  extraChildTools?: Tool[]
  /** Optional: acquire a concurrency slot before running a child. */
  acquireSlot?: (childRunId: string) => Promise<() => void>
}

/**
 * Create the delegation tools bound to the current run context.
 *
 * Returns an array with up to 2 tools: [delegate, delegate_parallel].
 * Returns empty array if depth > 0 (only root agent can delegate — flat hierarchy).
 */
export function createDelegateTools(ctx: DelegateContext): Tool[] {
  // Only the root orchestrator (depth 0) gets delegation tools.
  // Children are workers — they execute, they don't re-delegate.
  if (ctx.depth > 0) return []

  const toolNames = ctx.availableTools.map(t => t.name).join(", ")

  const delegateTool: Tool = {
    name: "delegate",
    description:
      `Delegate a sub-task to a focused child agent. The child runs independently ` +
      `with its own iteration loop and returns a final answer. ` +
      `The child is a WORKER — it cannot delegate further. ` +
      `IMPORTANT: After receiving the result, ALWAYS verify the output meets your ` +
      `expectations (check files, run tests, review output). If the result is ` +
      `incomplete or wrong, re-delegate with corrective feedback in the goal.`,

    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "Clear, specific goal for the child agent. Be precise — the child has no context beyond this.",
        },
        agentId: {
          type: "string",
          description: "Optional ID of a named agent definition to use. The child inherits that agent's system prompt and tools.",
        },
        instructions: {
          type: "string",
          description: "Optional system-level instructions for the child. Ignored if agentId is provided.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: `Optional subset of tool names. Ignored if agentId is provided. Available: ${toolNames}.`,
        },
        maxIterations: {
          type: "number",
          description: `Max iterations for the child (default: ${DEFAULT_CHILD_ITERATIONS}, max: 25).`,
        },
      },
      required: ["goal"],
    },

    async execute(args) {
      const goal = String(args.goal)
      const spec: ChildSpec = {
        goal,
        agentId: args.agentId ? String(args.agentId) : undefined,
        instructions: args.instructions ? String(args.instructions) : undefined,
        tools: Array.isArray(args.tools) ? args.tools.map(String) : undefined,
        maxIterations: args.maxIterations ? Number(args.maxIterations) : undefined,
      }

      const result = await spawnChild(ctx, spec)
      return result
    },
  }

  const delegateParallelTool: Tool = {
    name: "delegate_parallel",
    description:
      `Delegate MULTIPLE sub-tasks to child agents that run in PARALLEL. ` +
      `Each child is a WORKER — it executes independently and CANNOT delegate further. ` +
      `Results are collected and returned together. Use this when you have 2+ ` +
      `independent sub-tasks. One child failing does not stop the others. ` +
      `IMPORTANT: After receiving all results, VERIFY each output meets your ` +
      `expectations. If any result is incomplete or wrong, re-delegate that ` +
      `specific task with corrective feedback (use delegate for targeted rework).`,

    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              goal: { type: "string", description: "Specific goal for this child agent." },
              agentId: { type: "string", description: "Optional agent definition ID." },
              instructions: { type: "string", description: "Optional child instructions." },
              tools: { type: "array", items: { type: "string" }, description: "Optional tool subset." },
              maxIterations: { type: "number", description: "Max iterations (default: 15, max: 25)." },
            },
            required: ["goal"],
          },
          description: "Array of sub-tasks to run in parallel. Each gets its own child agent.",
        },
      },
      required: ["tasks"],
    },

    async execute(args) {
      const tasks = args.tasks as Array<{
        goal: string
        agentId?: string
        instructions?: string
        tools?: string[]
        maxIterations?: number
      }>

      if (!Array.isArray(tasks) || tasks.length === 0) {
        return "No tasks provided."
      }

      ctx.onChildTrace?.({
        kind: "delegation-parallel-start",
        depth: ctx.depth + 1,
        taskCount: tasks.length,
        goals: tasks.map(t => t.goal),
      })

      // Run all children concurrently with Promise.allSettled
      const results = await Promise.allSettled(
        tasks.map((task) =>
          spawnChild(ctx, {
            goal: String(task.goal),
            agentId: task.agentId ? String(task.agentId) : undefined,
            instructions: task.instructions ? String(task.instructions) : undefined,
            tools: task.tools?.map(String),
            maxIterations: task.maxIterations ? Number(task.maxIterations) : undefined,
          }),
        ),
      )

      ctx.onChildTrace?.({
        kind: "delegation-parallel-end",
        depth: ctx.depth + 1,
        taskCount: tasks.length,
        fulfilled: results.filter(r => r.status === "fulfilled").length,
        rejected: results.filter(r => r.status === "rejected").length,
      })

      // Format results as a structured report
      const lines = results.map((result, i) => {
        const goalLabel = tasks[i].goal.slice(0, 80)
        if (result.status === "fulfilled") {
          return `## Task ${i + 1}: ${goalLabel}\n${result.value}`
        }
        return `## Task ${i + 1}: ${goalLabel}\n[FAILED] ${result.reason}`
      })

      return lines.join("\n\n---\n\n")
    },
  }

  return [delegateTool, delegateParallelTool]
}

/**
 * @deprecated Use createDelegateTools instead. Kept for backward compatibility.
 */
export function createDelegateTool(ctx: DelegateContext): Tool | null {
  const tools = createDelegateTools(ctx)
  return tools.find(t => t.name === "delegate") ?? null
}

// ── Internal: spawn a single child agent ─────────────────────────

interface ChildSpec {
  goal: string
  agentId?: string
  instructions?: string
  tools?: string[]
  maxIterations?: number
}

async function spawnChild(ctx: DelegateContext, spec: ChildSpec): Promise<string> {
  const maxIter = Math.min(spec.maxIterations ?? DEFAULT_CHILD_ITERATIONS, 25)

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

  if (resolvedAgent) {
    childTools = resolvedAgent.tools.filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")
    childPrompt = resolvedAgent.systemPrompt
  } else if (spec.tools && spec.tools.length > 0) {
    const requested = new Set(spec.tools)
    childTools = ctx.availableTools.filter(t => requested.has(t.name))
  } else {
    childTools = ctx.availableTools.filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")
  }

  // Children are workers — no delegation tools. Just their execution tools.
  childTools = childTools.filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")

  // Inject extra tools (e.g., bus messaging tools)
  if (ctx.extraChildTools) {
    const extraNames = new Set(ctx.extraChildTools.map(t => t.name))
    childTools = [
      ...childTools.filter(t => !extraNames.has(t.name)),
      ...ctx.extraChildTools,
    ]
  }

  ctx.onChildTrace?.({
    kind: "delegation-start",
    goal: spec.goal,
    depth: ctx.depth + 1,
    tools: childTools.map(t => t.name),
    ...(resolvedAgent ? { agentId: resolvedAgent.id, agentName: resolvedAgent.name } : {}),
  })

  // Optionally acquire a queue slot
  let releaseSlot: (() => void) | undefined
  if (ctx.acquireSlot) {
    const childRunId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    releaseSlot = await ctx.acquireSlot(childRunId)
  }

  const child = new Agent(ctx.llm, childTools, {
    maxIterations: maxIter,
    systemPrompt: childPrompt ?? spec.instructions,
    verbose: false,
    signal: ctx.signal,
    onThinking: (content, _toolCalls, iteration) => {
      ctx.onChildTrace?.({
        kind: "delegation-iteration",
        depth: ctx.depth + 1,
        iteration: iteration + 1,
        maxIterations: maxIter,
      })
      if (content) {
        ctx.onChildTrace?.({
          kind: "thinking",
          text: `[D${ctx.depth + 1}] ${content.slice(0, 500)}`,
        })
      }
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onStep: (_messages, _iteration) => {
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
  })

  try {
    const answer = await child.run(spec.goal)

    ctx.onChildUsage?.(child.usage, child.llmCalls)
    ctx.onChildTrace?.({
      kind: "delegation-end",
      depth: ctx.depth + 1,
      status: "done",
      answer: answer.slice(0, 500),
    })

    return answer
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)

    ctx.onChildTrace?.({
      kind: "delegation-end",
      depth: ctx.depth + 1,
      status: "error",
      error: errMsg,
    })

    return `Delegation failed: ${errMsg}`
  } finally {
    releaseSlot?.()
  }
}
