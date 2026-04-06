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
import type { ExecutionEnvelope, SubagentTaskStep } from "../planner/types.js"
import type { LLMClient, TokenUsage, Tool } from "../types.js"

/** Default iteration budget for a child agent. */
const DEFAULT_CHILD_ITERATIONS = 15

/**
 * Dedicated system prompt for child worker agents.
 *
 * Key differences from the parent prompt:
 *   - No delegation instructions (children can't delegate)
 *   - Explicit anti-"let me know" / anti-premature-stop rules
 *   - Strong emphasis on completing the FULL goal, not just scaffolding
 *   - Self-verification required before finishing
 */
const CHILD_SYSTEM_PROMPT = `You are an autonomous worker agent. You receive a goal and work independently until it is FULLY accomplished.

Critical rules:
- You are NOT in a conversation. There is no human to talk to. NEVER say "let me know", "shall I proceed", "would you like me to", or any similar conversational phrase. These are FORBIDDEN.
- Work until the goal is COMPLETELY done — not scaffolded, not "foundational", not a skeleton. If the goal says "build a game", the game must be playable. If it says "implement a feature", the feature must work end-to-end.
- NEVER leave stub functions, TODO comments, or placeholder logic (e.g. \`return true\`, \`// implement later\`). Every function you write must contain REAL, COMPLETE logic. If a function is too complex to write at once, break it into smaller helper functions — but each one must be fully implemented.
- After creating web content (HTML/JS/CSS), ALWAYS use browser_check to verify it loads and works. Fix any errors before finishing.
- After writing code that can be tested, run it with run_command to verify correctness.
- You have a generous iteration budget. Use it ALL to produce thorough, polished, COMPLETE work. If you finish early, review your work — read the files you wrote and verify completeness.
- Quality matters more than speed. A working result in 10 iterations beats a broken skeleton in 2.
- Before finishing, use read_file to review your own code. Look for stubs, missing logic, hardcoded returns, and incomplete implementations. Fix anything you find.

Efficiency:
- Act directly. Use the right tool immediately.
- Use run_command with shell pipelines (find, grep, wc) instead of browsing file-by-file.
- Call multiple tools in one turn when they are independent.
- Keep tool outputs concise — pipe through head, tail, or grep.

Failure recovery:
- NEVER repeat the same command after it fails. Read the error and try a different approach.
- After 2 failed attempts at the same task, stop and re-assess entirely.

When the goal is fully achieved and verified, provide a concise summary of what you built or changed.`

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

  // Always use CHILD_SYSTEM_PROMPT as the behavioral base.
  // Named-agent prompts are prepended to it; ad-hoc instructions go into the goal.
  const effectivePrompt = childPrompt
    ? `${CHILD_SYSTEM_PROMPT}\n\n--- Agent-specific instructions ---\n${childPrompt}`
    : CHILD_SYSTEM_PROMPT

  // If the parent provided ad-hoc instructions, fold them into the goal so
  // the child sees them as task context, not as a system-prompt replacement.
  const effectiveGoal = spec.instructions
    ? `${spec.goal}\n\nAdditional instructions:\n${spec.instructions}`
    : spec.goal

  const child = new Agent(ctx.llm, childTools, {
    maxIterations: maxIter,
    systemPrompt: effectivePrompt,
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
    const answer = await child.run(effectiveGoal)

    // Detect if the child hit its iteration limit without completing
    const hitLimit = answer.startsWith("Agent stopped after")

    ctx.onChildUsage?.(child.usage, child.llmCalls)
    ctx.onChildTrace?.({
      kind: "delegation-end",
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

// ── Planner-initiated delegation (typed execution envelope) ─────

/**
 * Spawn a child agent for a planner-generated subagent_task step.
 *
 * Unlike ad-hoc delegation, this uses the ExecutionEnvelope to:
 *   - Build a rich prompt with objective, acceptance criteria, and context
 *   - Scope the child's tool access to requiredToolCapabilities
 *   - Pass workspace and artifact constraints
 */
export async function spawnChildForPlan(
  ctx: DelegateContext,
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope,
): Promise<string> {
  // Build the child's goal from the step's contract
  const goalParts: string[] = [
    `## Objective\n${step.objective}`,
  ]

  if (step.inputContract) {
    goalParts.push(`## Input Context\n${step.inputContract}`)
  }

  if (step.acceptanceCriteria.length > 0) {
    goalParts.push(
      `## Acceptance Criteria (ALL must be met)\n${step.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    )
  }

  if (envelope.targetArtifacts.length > 0) {
    goalParts.push(
      `## Target Files\nYou are responsible for creating/modifying:\n${envelope.targetArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  if (envelope.requiredSourceArtifacts.length > 0) {
    goalParts.push(
      `## Source Files (read these first)\n${envelope.requiredSourceArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  goalParts.push(
    `## Workspace\nRoot: ${envelope.workspaceRoot}\nWrite scope: ${envelope.allowedWriteRoots.join(", ") || envelope.workspaceRoot}`,
  )

  const goal = goalParts.join("\n\n")

  // Filter tools based on the envelope's allowedTools / requiredToolCapabilities
  let childTools: Tool[]
  const allowedToolNames = new Set([
    ...envelope.allowedTools,
    ...step.requiredToolCapabilities,
  ])

  if (allowedToolNames.size > 0) {
    childTools = ctx.availableTools.filter(t =>
      allowedToolNames.has(t.name) && t.name !== "delegate" && t.name !== "delegate_parallel",
    )
  } else {
    childTools = ctx.availableTools.filter(t =>
      t.name !== "delegate" && t.name !== "delegate_parallel",
    )
  }

  // Inject extra tools
  if (ctx.extraChildTools) {
    const extraNames = new Set(ctx.extraChildTools.map(t => t.name))
    childTools = [
      ...childTools.filter(t => !extraNames.has(t.name)),
      ...ctx.extraChildTools,
    ]
  }

  // Parse max iterations from budget hint
  const budgetMatch = step.maxBudgetHint.match(/(\d+)\s*iteration/i)
  const maxIter = Math.min(budgetMatch ? parseInt(budgetMatch[1], 10) : DEFAULT_CHILD_ITERATIONS, 25)

  ctx.onChildTrace?.({
    kind: "planner-delegation-start",
    goal: step.objective,
    stepName: step.name,
    depth: ctx.depth + 1,
    tools: childTools.map(t => t.name),
    envelope: {
      workspaceRoot: envelope.workspaceRoot,
      effectClass: envelope.effectClass,
      verificationMode: envelope.verificationMode,
      targetArtifacts: envelope.targetArtifacts,
    },
  })

  let releaseSlot: (() => void) | undefined
  if (ctx.acquireSlot) {
    const childRunId = `plan-${step.name}-${Date.now()}`
    releaseSlot = await ctx.acquireSlot(childRunId)
  }

  const child = new Agent(ctx.llm, childTools, {
    maxIterations: maxIter,
    systemPrompt: CHILD_SYSTEM_PROMPT,
    verbose: false,
    signal: ctx.signal,
    onThinking: (_content, _toolCalls, iteration) => {
      ctx.onChildTrace?.({
        kind: "planner-delegation-iteration",
        stepName: step.name,
        depth: ctx.depth + 1,
        iteration: iteration + 1,
        maxIterations: maxIter,
      })
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onStep: () => {
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
  })

  try {
    const answer = await child.run(goal)
    const hitLimit = answer.startsWith("Agent stopped after")

    ctx.onChildUsage?.(child.usage, child.llmCalls)
    ctx.onChildTrace?.({
      kind: "planner-delegation-end",
      stepName: step.name,
      depth: ctx.depth + 1,
      status: hitLimit ? "error" : "done",
      answer: answer.slice(0, 500),
    })

    if (hitLimit) {
      return `⚠ DELEGATION INCOMPLETE — child agent for step "${step.name}" used all ${maxIter} iterations without finishing.\nChild's last output: ${answer}`
    }

    return answer
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    ctx.onChildTrace?.({
      kind: "planner-delegation-end",
      stepName: step.name,
      depth: ctx.depth + 1,
      status: "error",
      error: errMsg,
    })
    return `Delegation failed: ${errMsg}`
  } finally {
    releaseSlot?.()
  }
}
