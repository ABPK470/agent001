/**
 * Delegate tool — ephemeral sub-agent spawning.
 *
 * This is the core of true agentic delegation. When the parent agent
 * calls `delegate`, it spawns a child agent inline with:
 *   - A sub-goal (required)
 *   - An optional system prompt / instructions for the child
 *   - An optional subset of tools the child may use
 *   - A max iteration cap (default 15, capped by remaining parent budget)
 *
 * The child runs the same Agent loop, sharing the parent's abort signal.
 * Its final answer becomes the tool result for the parent. From the parent's
 * perspective it's just a tool call that takes longer.
 *
 * Key properties:
 *   - Ephemeral: the child has no persistent identity — it's born, works, returns, dies
 *   - Recursive: the child can also delegate (up to a configurable depth limit)
 *   - Governed: the child's tool calls go through the same governance layer
 *   - Cancellable: parent abort signal propagates to children
 */

import { Agent } from "../agent.js"
import type { LLMClient, TokenUsage, Tool } from "../types.js"

/** Default maximum nesting depth to prevent infinite recursion. */
const DEFAULT_MAX_DEPTH = 3

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
}

/**
 * Create a delegate tool bound to the current run context.
 *
 * This is a factory — each run gets its own delegate tool instance
 * because it needs to close over the LLM, tools, and abort signal.
 */
export function createDelegateTool(ctx: DelegateContext): Tool | null {
  const maxDepth = ctx.maxDepth ?? DEFAULT_MAX_DEPTH

  // Don't allow delegation beyond max depth
  if (ctx.depth >= maxDepth) return null

  return {
    name: "delegate",
    description:
      `Delegate a sub-task to a focused child agent. The child runs independently ` +
      `with its own iteration loop and returns a final answer. Use this when:\n` +
      `- A sub-task is self-contained and benefits from focused attention\n` +
      `- You want to isolate a complex operation (research, analysis, multi-step build)\n` +
      `- Parallel-style decomposition: break work into independent pieces\n\n` +
      `The child agent has access to the same tools as you (or a subset you specify). ` +
      `Current delegation depth: ${ctx.depth}/${maxDepth}.`,

    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "Clear, specific goal for the child agent. Be precise — the child has no context beyond this.",
        },
        agentId: {
          type: "string",
          description: "Optional ID of a named agent definition to use. The child will inherit that agent's system prompt and tools. Overrides 'instructions' and 'tools' if provided.",
        },
        instructions: {
          type: "string",
          description: "Optional system-level instructions for the child (role, constraints, output format). Ignored if agentId is provided. Defaults to a general-purpose prompt.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: `Optional subset of tool names the child may use. Ignored if agentId is provided. Available: ${ctx.availableTools.map(t => t.name).join(", ")}. Omit to give all tools.`,
        },
        maxIterations: {
          type: "number",
          description: `Max iterations for the child (default: ${DEFAULT_CHILD_ITERATIONS}, max: 25). Lower = faster + cheaper.`,
        },
      },
      required: ["goal"],
    },

    async execute(args) {
      const goal = String(args.goal)
      const agentId = args.agentId ? String(args.agentId) : undefined
      const instructions = args.instructions ? String(args.instructions) : undefined
      const maxIter = Math.min(Number(args.maxIterations) || DEFAULT_CHILD_ITERATIONS, 25)

      // If agentId is provided, resolve the named agent definition
      let resolvedAgent: ResolvedAgent | null = null
      if (agentId && ctx.resolveAgent) {
        resolvedAgent = ctx.resolveAgent(agentId)
        if (!resolvedAgent) {
          return `Delegation failed: agent "${agentId}" not found. Available agents can be discovered via the system.`
        }
      }

      // Resolve tools: named agent's tools > explicit tool list > all tools
      let childTools: Tool[]
      let childPrompt: string | undefined

      if (resolvedAgent) {
        // Use the named agent's tools and prompt
        childTools = resolvedAgent.tools.filter(t => t.name !== "delegate")
        childPrompt = resolvedAgent.systemPrompt
      } else if (Array.isArray(args.tools) && args.tools.length > 0) {
        const requested = new Set(args.tools.map(String))
        childTools = ctx.availableTools.filter(t => requested.has(t.name))
        // Always filter out the delegate tool itself from the subset if it wasn't explicitly requested
        // (the child gets its own delegate tool via the recursive context below)
      } else {
        // Give all tools except the current delegate tool (child gets its own)
        childTools = ctx.availableTools.filter(t => t.name !== "delegate")
      }

      // Create a delegate tool for the child (recursive, depth + 1)
      const childDelegate = createDelegateTool({
        ...ctx,
        depth: ctx.depth + 1,
      })
      if (childDelegate) {
        childTools = [...childTools.filter(t => t.name !== "delegate"), childDelegate]
      }

      // Emit delegation-start trace
      ctx.onChildTrace?.({
        kind: "delegation-start",
        goal,
        depth: ctx.depth + 1,
        tools: childTools.map(t => t.name),
        ...(resolvedAgent ? { agentId: resolvedAgent.id, agentName: resolvedAgent.name } : {}),
      })

      const child = new Agent(ctx.llm, childTools, {
        maxIterations: maxIter,
        systemPrompt: childPrompt ?? instructions,
        verbose: false,
        signal: ctx.signal,
        onStep: (_messages, iteration) => {
          // Forward token usage to parent
          ctx.onChildUsage?.(child.usage, child.llmCalls)
          // Emit iteration trace for the child
          ctx.onChildTrace?.({
            kind: "delegation-iteration",
            depth: ctx.depth + 1,
            iteration: iteration + 1,
            maxIterations: maxIter,
          })
        },
      })

      try {
        const answer = await child.run(goal)

        // Roll up final usage
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
      }
    },
  }
}
