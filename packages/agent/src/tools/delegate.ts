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
const DEFAULT_CHILD_ITERATIONS = 20

/**
 * Hard cap on child iterations.
 * agenc-core uses dynamic budgets based on contract shape, but always has a generous cap.
 */
const MAX_CHILD_ITERATIONS = 50

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

Task execution protocol:
1. Start by reading the ## Workspace section of your goal to know WHERE you are working.
2. If your goal lists Source Files, read those files FIRST with read_file to understand the current state.
3. Start working on the objective immediately — do NOT run exploratory commands like \`find\` or \`ls\` on the workspace root. Your goal already tells you exactly which files to read and which files to create/modify.
4. Use the right tool in your first real action — NEVER end a turn without a tool call.
5. If a command fails, read the error, fix the code, and retry — do NOT stop and report the error.
6. Keep iterating until the task succeeds or you have genuinely exhausted options.
7. Finish with grounded results backed by tool evidence.

Critical rules:
- You are NOT in a conversation. There is no human. NEVER say "let me know", "shall I proceed", "would you like me to", or similar. These are FORBIDDEN.
- Work until the goal is COMPLETELY done — not scaffolded, not "foundational", not a skeleton. If the goal says "build a game", the game must be playable. If it says "implement a feature", the feature must work end-to-end.
- NEVER leave stub functions, TODO comments, or placeholder logic (e.g. \`return true\`, \`// implement later\`). Every function must contain REAL, COMPLETE logic.
- ALL file paths are RELATIVE to the workspace root (e.g. "game/index.html", not "/Users/.../game/index.html"). Never use absolute paths.
- WORKSPACE CONTAINMENT: If your goal specifies Target Files with a directory prefix (e.g. "tmp/game/index.html"), ALL files you create MUST go in that SAME directory. NEVER create files in a different directory or strip the directory prefix. If targets are in "tmp/game/", every file you write must start with "tmp/game/". This is non-negotiable.
- If prior steps created files, the EXACT paths are listed in the ## Source Files section. Use read_file with those EXACT paths — do not guess or shorten them.
- After creating web content (HTML/JS/CSS), ALWAYS use browser_check to verify it loads and works. Fix any errors before finishing.
- After writing testable code, run it with run_command to verify correctness.
- Before finishing, use read_file to review your own code. Look for stubs, missing logic, hardcoded returns. Fix anything you find.

Writing strategy — INCREMENTAL, NOT BIG-BANG:
- Do NOT try to write an entire complex file in one write_file call. If the file will be >150 lines, write it in stages:
  1. Write the core structure + first set of functions
  2. Run/test to verify what you have so far works
  3. Append or extend with the next set of functions
  4. Run/test again
- If your first write_file attempt gets errors, FIX the specific errors — do NOT delete everything and start over. Targeted fixes are faster than full rewrites.
- NEVER rewrite an entire file from scratch just because one function has a bug. Fix the bug.

Efficiency:
- Use run_command with shell pipelines (find, grep, wc) instead of browsing file-by-file.
- Call multiple tools in one turn when they are independent.
- Keep tool outputs concise — pipe through head, tail, or grep.

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
          description: `Max iterations for the child (default: ${DEFAULT_CHILD_ITERATIONS}, max: ${MAX_CHILD_ITERATIONS}).`,
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
              maxIterations: { type: "number", description: `Max iterations (default: 15, max: ${MAX_CHILD_ITERATIONS}).` },
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

  // Buffer LLM request/response events so they emit AFTER the iteration marker
  // (onLlmCall fires before onThinking, but the iteration marker is in onThinking)
  let pendingLlmEvents: Record<string, unknown>[] = []

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
      // Flush buffered LLM events after the iteration marker
      for (const ev of pendingLlmEvents) ctx.onChildTrace?.(ev)
      pendingLlmEvents = []
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
    onNudge: (data) => {
      ctx.onChildTrace?.({
        kind: "nudge",
        tag: `[D${ctx.depth + 1}] ${data.tag}`,
        message: data.message,
        iteration: data.iteration,
      })
    },
    onLlmCall: (data) => {
      if (data.phase === "request") {
        pendingLlmEvents.push({
          kind: "llm-request",
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
          kind: "llm-response",
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
  // IMPORTANT: Workspace and path context goes FIRST so the child knows
  // where it's working before reading the objective
  // Derive the child's working subdirectory from target/source artifacts
  const artifactPaths = [
    ...envelope.targetArtifacts,
    ...envelope.requiredSourceArtifacts,
  ]
  // Extract the common output directory from all artifact paths.
  // Use the full directory path (e.g. "tmp/game") not just the first segment.
  const artifactDirs = artifactPaths
    .map(p => {
      const parts = p.split("/")
      return parts.length > 1 ? parts.slice(0, -1).join("/") : null
    })
    .filter((d): d is string => d !== null)
  const uniqueDirs = [...new Set(artifactDirs)]

  // Find the longest common prefix directory
  let outputDir: string | null = null
  if (uniqueDirs.length === 1) {
    outputDir = uniqueDirs[0]
  } else if (uniqueDirs.length > 1) {
    // Find common prefix of all directories
    const segments = uniqueDirs.map(d => d.split("/"))
    const common: string[] = []
    for (let i = 0; i < segments[0].length; i++) {
      const seg = segments[0][i]
      if (segments.every(s => s[i] === seg)) common.push(seg)
      else break
    }
    if (common.length > 0) outputDir = common.join("/")
  }

  const scopeHint = outputDir
    ? `\nOUTPUT DIRECTORY: All your files MUST be created inside \`${outputDir}/\`. If you need to see what exists, run \`ls ${outputDir}/\` — NEVER run find or ls on the workspace root. Do NOT create files outside \`${outputDir}/\`.`
    : ""

  const goalParts: string[] = [
    `## Workspace — READ THIS FIRST\nYou are working in: ${envelope.workspaceRoot}\nAll file paths are relative to this directory. Use relative paths (e.g. "tmp/index.html") with read_file/write_file.\nWrite scope: ${envelope.allowedWriteRoots.join(", ") || envelope.workspaceRoot}${scopeHint}`,
  ]

  if (envelope.requiredSourceArtifacts.length > 0) {
    goalParts.push(
      `## Source Files — READ THESE FIRST\nThese files should already exist (created by prior steps). Read them before doing anything:\n${envelope.requiredSourceArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  goalParts.push(`## Objective\n${step.objective}`)

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

  const goal = goalParts.join("\n\n")

  // Filter tools based on the envelope's allowedTools / requiredToolCapabilities
  let childTools: Tool[]
  const allowedToolNames = new Set([
    ...envelope.allowedTools,
    ...step.requiredToolCapabilities,
  ])

  // Children that write files ALWAYS need read_file + verification tools,
  // even if the LLM plan forgot to list them. Without these the child
  // cannot self-review and gets stuck in write-only loops.
  if (allowedToolNames.size > 0 && envelope.effectClass !== "readonly") {
    for (const essential of ["read_file", "list_directory", "browser_check", "run_command"]) {
      allowedToolNames.add(essential)
    }
  }

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
  // agenc-core pattern: contract-shaped budget floor.
  // Estimate minimum iterations from the step's contract shape:
  //   + targetArtifacts count (each needs at least 1 write)
  //   + acceptanceCriteria count (each may need verification)
  //   + source artifacts (each needs a read)
  //   + verificationMode pass if applicable
  const contractFloor = Math.min(12, Math.max(1,
    envelope.targetArtifacts.length +
    step.acceptanceCriteria.length +
    envelope.requiredSourceArtifacts.length +
    (envelope.verificationMode !== "none" ? 1 : 0) +
    (envelope.effectClass !== "readonly" && envelope.targetArtifacts.length > 0 ? 1 : 0)
  ))
  const parsedBudget = budgetMatch ? parseInt(budgetMatch[1], 10) : DEFAULT_CHILD_ITERATIONS
  // Use whichever is larger: the parsed budget hint or the contract floor, capped at MAX_CHILD_ITERATIONS
  const maxIter = Math.min(Math.max(parsedBudget, contractFloor), MAX_CHILD_ITERATIONS)

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

  // Buffer LLM request/response events so they emit AFTER the iteration marker
  let pendingPlannerLlmEvents: Record<string, unknown>[] = []

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
      // Flush buffered LLM events after the iteration marker
      for (const ev of pendingPlannerLlmEvents) ctx.onChildTrace?.(ev)
      pendingPlannerLlmEvents = []
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onStep: () => {
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onNudge: (data) => {
      ctx.onChildTrace?.({
        kind: "nudge",
        tag: `[${step.name}] ${data.tag}`,
        message: data.message,
        iteration: data.iteration,
      })
    },
    onLlmCall: (data) => {
      if (data.phase === "request") {
        pendingPlannerLlmEvents.push({
          kind: "llm-request",
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
        pendingPlannerLlmEvents.push({
          kind: "llm-response",
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
