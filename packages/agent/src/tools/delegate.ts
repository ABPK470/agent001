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

import { readFile as fsReadFile } from "node:fs/promises"
import { resolve as pathResolve } from "node:path"
import { Agent } from "../agent.js"
import { detectPlaceholderPatterns } from "../code-quality.js"
import type { DelegateResult } from "../planner/pipeline.js"
import type {
    ChildExecutionResult,
    ExecutionEnvelope,
    SubagentTaskStep,
    VerificationAttempt,
} from "../planner/types.js"
import type { LLMClient, TokenUsage, Tool } from "../types.js"

/** Default iteration budget for a child agent. */
const DEFAULT_CHILD_ITERATIONS = 50

/**
 * Hard cap on child iterations.
 * agenc-core uses dynamic budgets based on contract shape, but always has a generous cap.
 */
const MAX_CHILD_ITERATIONS = 180

const COMPLEX_IMPLEMENTATION_RE = /\b(?:game|rules?|engine|validator|workflow|state machine|parser|compiler|algorithm|reconciliation|move validation|checkmate|castling|en passant|promotion|scheduling|constraint|domain logic|business logic)\b/i

/**
 * Dedicated system prompt for child worker agents.
 *
 * Key differences from the parent prompt:
 *   - No delegation instructions (children can't delegate)
 *   - Explicit anti-"let me know" / anti-premature-stop rules
 *   - Strong emphasis on completing the FULL goal, not just scaffolding
 *   - Self-verification required before finishing
 */
export const CHILD_SYSTEM_PROMPT = `You are an autonomous worker agent in a PIPELINE. Other agents may have already completed prior steps and created files. You receive a goal and work independently until it is FULLY accomplished.

Task execution protocol:
1. Start by reading the ## Workspace section of your goal to know WHERE you are working.
2. If your goal lists Source Files, read ALL of them FIRST with read_file. These files were created by prior pipeline steps — they contain working code you must build on top of.
3. Start working on the objective immediately — do NOT run exploratory commands like \`find\` or \`ls\` on the workspace root. Your goal already tells you exactly which files to read and which files to create/modify.
4. Use the right tool in your first real action — NEVER end a turn without a tool call.
5. If a command fails, read the error, fix the code, and retry — do NOT stop and report the error.
6. Keep iterating until the task succeeds or you have genuinely exhausted options.

PIPELINE AWARENESS — CRITICAL:
- You are NOT the only agent. Other agents have run before you and may run after you.
- Files listed in Source Files ALREADY EXIST with working code. Do NOT recreate or overwrite them.
- Your job is to ADD your piece to the project, not rebuild everything from scratch.
- If Source Files include a BLUEPRINT.md, it defines the function signatures AND algorithmic contracts you MUST follow exactly.
- Use the exact function names, parameter names, and return types from the blueprint or existing source files.
- The blueprint's ALGORITHMIC CONTRACTS tell you exactly what each function must implement — which cases to handle, which rules to enforce, which edge cases to cover. A function called validateMove with a contract listing 6 piece types MUST implement movement validation for ALL 6 piece types. A function with a contract listing castling, en passant, and promotion MUST handle ALL three special moves. Implementing only 1-2 cases and returning a default for the rest is a STUB that will be REJECTED.

Critical rules:
- You are NOT in a conversation. There is no human. NEVER say "let me know", "shall I proceed", "would you like me to", or similar. These are FORBIDDEN.
- Work until the goal is COMPLETELY done — not scaffolded, not "foundational", not a skeleton. If the goal says "build a game", the game must be playable. If it says "implement a feature", the feature must work end-to-end.
- NEVER leave stub functions, TODO comments, or placeholder logic (e.g. \`return true\`, \`return []\`, \`return {}\`, \`return false\`, \`// implement later\`, \`/* Logic for X */\`). Every function must contain REAL, COMPLETE logic.
- A function whose body is just a comment plus \`return []\` or \`return false\` is a STUB even if it compiles. The verifier WILL detect and reject it.
- ALL file paths are RELATIVE to the workspace root (e.g. "game/index.html", not "/Users/.../game/index.html"). Never use absolute paths.
- WORKSPACE CONTAINMENT: If your goal specifies Target Files with a directory prefix (e.g. "tmp/game/index.html"), ALL files you create MUST use the EXACT paths listed in Target Files. Do not add or remove any directory prefix. Use the paths exactly as written.
- If prior steps created files, the EXACT paths are listed in the ## Source Files section. Use read_file with those EXACT paths — do not guess or shorten them.

COMPLETE IMPLEMENTATION — NO STUBS OF ANY KIND:
- When implementing logic that handles MULTIPLE cases (e.g. validation rules, route handling, business rules), you MUST implement EVERY case with real logic.
- A function that handles one or two cases and then has \`return true\` or \`return false\` as a catch-all for the remaining cases is a STUB. Your verifier WILL reject it.
- A function that returns \`[]\` or \`{}\` without doing real work is a STUB. Wrapping it in a comment like \`/* Logic for X */\` does not make it real code. The verifier WILL reject it.
- A comment saying "will go here", "will be added later", or "specific logic goes here" is a STUB marker and will be rejected.
- BEFORE writing each function, mentally enumerate ALL cases it must handle. Then implement ALL of them in one go.
- DO NOT write all files first and then "come back" to fill in logic. Implement each file COMPLETELY before moving to the next. If a file has 10 functions, ALL 10 must have real logic before you move on.
- DEPENDENCY CLOSURE RULE: every non-builtin symbol you call or reference in a file must be defined in that same file or imported from an existing declared dependency file. Never leave helper calls like \`foo()\` or constants like \`BAR\` dangling without a real definition/import.
- VISUAL WIRING RULE: every CSS class referenced by HTML or JS for UI state/feedback must have a real rule in the related stylesheet. If you build a 2D board/grid with alternating cell visuals, compute the pattern from row/column parity or equivalent coordinates — do NOT rely on flat \`:nth-child(odd/even)\` striping unless the DOM is actually one-dimensional.

CRITICAL — write_file REPLACES the ENTIRE file:
- write_file OVERWRITES the full file content every time. It does NOT append.
- To ADD code to an existing file: read_file first, then write_file with ALL the old content PLUS your new code combined.
- If your write_file content is getting very long (300+ lines), it's fine — include everything. A complete file that is long is FAR better than a partial file that destroys prior work.
- FUNCTION PRESERVATION RULE: When you read an existing file and rewrite it, you MUST preserve ALL existing functions/methods. BEFORE calling write_file, verify that your new content contains EVERY function from the original. If your fix only touches 1-2 functions, copy the ENTIRE file and modify only those functions — keep everything else exactly as-is. Removing functions that other code calls will crash the system and the verifier WILL reject your work.

PREFER replace_in_file FOR FIXES:
- When you need to fix or update a SPECIFIC function/section in an existing file, use replace_in_file instead of write_file.
- replace_in_file takes old_string (exact text to find) and new_string (replacement), leaving all other content untouched.
- This ELIMINATES the risk of accidentally removing other functions during a rewrite.
- Use write_file for CREATING new files. Use replace_in_file for MODIFYING existing files.
- Use append_file only for true append-only artifacts such as logs, notes, or markdown sections. Do NOT use append_file to patch functions inside existing code files.
- Only use write_file to modify an existing file when you need to change MORE THAN HALF of its content.

FILE ARCHITECTURE — CHOOSE BY OWNERSHIP AND COHESION, NOT ARBITRARY LINE CAPS:
- Split work into multiple files when the target artifacts or blueprint already define multiple owned modules, or when separate concerns reduce overwrite risk.
- If the contract clearly calls for one cohesive owned file, it is acceptable to write several hundred lines in that file. Do NOT invent extra modules just to keep files short.
- A large coherent file is acceptable; an incomplete file is not. Preserve exact target paths and file ownership.
- If you do use multiple browser files, load them via multiple \`<script src="file.js">\` tags in dependency order in index.html.
- WRITE EACH OWNED FILE COMPLETELY IN ONE mutation. Do not write a skeleton and then fill it in later.

Browser projects:
- For browser-based HTML/JS/CSS projects, use the simplest runtime boundary that matches the goal. If HTML loads cross-file browser JS/TS, use ES modules consistently: load entry files with \`<script type="module" src="...">\` and share code with \`import\`/\`export\`.
- Do NOT use browser globals, \`window.X\` contracts, \`module.exports\`, or \`require()\` for browser-loaded runtime files unless the goal explicitly requires a single-file inline script with no cross-file sharing.
- Do NOT try to install npm packages, start HTTP servers, or run \`npm init\`. The browser_check tool loads files directly — no server needed.

Writing approach:
- For new files, write the complete implementation in one go. Include ALL logic needed for the acceptance criteria.
- For existing files, ALWAYS read_file first, then write_file with the FULL updated content.
- IMPORTANT: "it renders" is NOT "it works". A UI that displays but has broken interactions or logic is NOT done. browser_check only checks for JavaScript load errors — it does NOT test functionality.
- If your first write_file attempt gets errors, FIX the specific errors — do NOT delete everything and start over.

Retry handling:
- If your objective contains "[RETRY — fix these issues]", this means you ALREADY wrote code in a previous attempt that had problems.
- Your #1 priority on retry is to READ EVERY SOURCE FILE listed in the goal to see your prior work.
- Then make TARGETED fixes or additions — do NOT start over.

Efficiency:
- Use run_command with shell pipelines (find, grep, wc) instead of browsing file-by-file.
- Call multiple tools in one turn when they are independent.

MANDATORY BEFORE FINISHING — YOU MUST DO THIS:
After writing code and before providing your final answer, you MUST complete this checklist:
1. Use read_file to re-read EVERY file you wrote.
2. Open the ## Acceptance Criteria section of your goal.
3. Go through each criterion ONE BY ONE. For each one, confirm there is REAL, WORKING code implementing it.
4. If ANY criterion is missing or implemented with a stub/placeholder, you MUST keep working.
5. Run browser_check ONLY if all referenced runtime assets for the checked page are already present in your current step's owned/available files. If dependencies are produced by later steps, skip browser_check and rely on post-write read_file verification.
6. Only after ALL criteria are verified with real code may you provide your final summary.
If you skip this checklist, your output WILL be rejected and you will waste a retry.`

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
              maxIterations: { type: "number", description: `Max iterations (default: ${DEFAULT_CHILD_ITERATIONS}, max: ${MAX_CHILD_ITERATIONS}).` },
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

interface CanonicalPathMap {
  readonly targets: readonly string[]
  readonly targetSet: ReadonlySet<string>
  readonly byBasename: ReadonlyMap<string, readonly string[]>
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function buildVerificationAttempts(toolCalls: readonly { name: string; args: Record<string, unknown>; result: string; isError: boolean }[]): VerificationAttempt[] {
  return toolCalls
    .filter((call) => call.name === "browser_check" || call.name === "read_file" || call.name === "run_command")
    .map((call) => ({
      toolName: call.name,
      target: typeof call.args.path === "string"
        ? call.args.path
        : typeof call.args.command === "string"
          ? call.args.command
          : undefined,
      success: !call.isError && !/^Error:/i.test(call.result) && !/\b(?:Uncaught Exceptions|Console Errors|Network Failures|SyntaxError|failed?)\b/i.test(call.result),
      summary: call.result.slice(0, 240),
    }))
}

function buildChildExecutionResult(output: string, toolCalls: readonly { name: string; args: Record<string, unknown>; result: string; isError: boolean }[]): ChildExecutionResult {
  const mutatedArtifacts = uniqueStrings(toolCalls
    .filter((call) => !call.isError && (call.name === "write_file" || call.name === "replace_in_file" || call.name === "append_file"))
    .map((call) => typeof call.args.path === "string" ? call.args.path : "")
    .map((path) => path.replace(/^\.\//, "")))

  const blockers = uniqueStrings(toolCalls
    .filter((call) => call.isError || /^Error:/i.test(call.result))
    .map((call) => `${call.name}: ${call.result.slice(0, 240)}`))

  return {
    status: blockers.length > 0
      ? (mutatedArtifacts.length > 0 ? "blocked" : "failed")
      : "success",
    summary: output.slice(0, 400),
    producedArtifacts: mutatedArtifacts,
    modifiedArtifacts: mutatedArtifacts,
    verificationAttempts: buildVerificationAttempts(toolCalls),
    unresolvedBlockers: blockers,
  }
}

export interface PlannerChildBudgetMetrics {
  readonly hint: string
  readonly parsedHint: number
  readonly baseBudget: number
  readonly contractFloor: number
  readonly complexityBoost: number
  readonly computedMaxIterations: number
  readonly targetArtifactCount: number
  readonly requiredSourceArtifactCount: number
  readonly acceptanceCriteriaCount: number
  readonly codeArtifactCount: number
  readonly hasComplexImplementation: boolean
  readonly hasBlueprintSource: boolean
  readonly verificationMode: ExecutionEnvelope["verificationMode"]
}

export function computePlannerChildBudgetMetrics(
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope,
): PlannerChildBudgetMetrics {
  const budgetMatch = step.maxBudgetHint.match(/(\d+)\s*iteration/i)
  const parsedBudget = budgetMatch ? parseInt(budgetMatch[1], 10) : DEFAULT_CHILD_ITERATIONS
  const baseBudget = Math.max(parsedBudget, DEFAULT_CHILD_ITERATIONS)
  const codeArtifactCount = envelope.targetArtifacts.filter(a => /\.(?:js|jsx|ts|tsx|py|rb|go|rs|java|php)$/i.test(a)).length
  const isWriterStep = envelope.effectClass !== "readonly" && envelope.targetArtifacts.length > 0
  const combinedContractText = `${step.objective} ${step.acceptanceCriteria.join(" ")}`
  const hasComplexImplementation = COMPLEX_IMPLEMENTATION_RE.test(combinedContractText)
  const hasBlueprintSource = envelope.requiredSourceArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))

  const contractFloor = Math.min(60, Math.max(18,
    envelope.targetArtifacts.length * 2 +
    step.acceptanceCriteria.length * 3 +
    envelope.requiredSourceArtifacts.length +
    (envelope.verificationMode !== "none" ? 6 : 0) +
    (isWriterStep ? 8 : 0),
  ))

  const complexityBoost = isWriterStep
    ? Math.min(100,
      (step.acceptanceCriteria.length >= 8 ? 34 : step.acceptanceCriteria.length >= 6 ? 24 : step.acceptanceCriteria.length >= 4 ? 12 : 0) +
      (codeArtifactCount >= 4 ? 26 : codeArtifactCount >= 2 ? 16 : codeArtifactCount === 1 ? 8 : 0) +
      (envelope.requiredSourceArtifacts.length >= 4 ? 16 : envelope.requiredSourceArtifacts.length >= 2 ? 8 : envelope.requiredSourceArtifacts.length === 1 ? 4 : 0) +
      (envelope.verificationMode !== "none" ? 10 : 0) +
      (hasComplexImplementation ? 36 : 0) +
      (hasBlueprintSource ? 10 : 0),
    )
    : 0

  const adaptiveBudget = baseBudget + complexityBoost
  const computedMaxIterations = Math.min(Math.max(baseBudget, contractFloor, adaptiveBudget), MAX_CHILD_ITERATIONS)

  return {
    hint: step.maxBudgetHint,
    parsedHint: parsedBudget,
    baseBudget,
    contractFloor,
    complexityBoost,
    computedMaxIterations,
    targetArtifactCount: envelope.targetArtifacts.length,
    requiredSourceArtifactCount: envelope.requiredSourceArtifacts.length,
    acceptanceCriteriaCount: step.acceptanceCriteria.length,
    codeArtifactCount,
    hasComplexImplementation,
    hasBlueprintSource,
    verificationMode: envelope.verificationMode,
  }
}

export function computePlannerChildMaxIterations(
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope,
): number {
  return computePlannerChildBudgetMetrics(step, envelope).computedMaxIterations
}

function normalizeRelativePath(path: string, workspaceRoot?: string): string {
  let p = path.replace(/\\/g, "/").trim()
  if (workspaceRoot) {
    const wsNorm = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")
    if (p.startsWith(`${wsNorm}/`)) {
      p = p.slice(wsNorm.length + 1)
    }
  }
  p = p.replace(/^\.\//, "").replace(/^\//, "")
  const segs = p.split("/").filter(Boolean)
  return segs.join("/")
}

function chooseCanonicalRoot(paths: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const slash = p.lastIndexOf("/")
    if (slash <= 0) continue
    const dir = p.slice(0, slash)
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = -1
  for (const [dir, count] of counts) {
    if (count > bestCount) {
      best = dir
      bestCount = count
    }
  }
  return best
}

function canonicalizeArtifacts(artifacts: readonly string[], workspaceRoot?: string): string[] {
  const normalized = artifacts
    .map(a => normalizeRelativePath(a, workspaceRoot))
    .filter(Boolean)
  if (normalized.length === 0) return []

  const canonicalRoot = chooseCanonicalRoot(normalized)
  if (!canonicalRoot) return [...new Set(normalized)]

  const canonical = normalized.map((p) => {
    if (p.includes("/")) return p
    return `${canonicalRoot}/${p}`
  })
  return [...new Set(canonical)]
}

function buildCanonicalPathMap(targetArtifacts: readonly string[], workspaceRoot?: string): CanonicalPathMap {
  const targets = canonicalizeArtifacts(targetArtifacts, workspaceRoot)
  const targetSet = new Set(targets)
  const byBasename = new Map<string, string[]>()
  for (const t of targets) {
    const base = t.split("/").pop() ?? t
    const arr = byBasename.get(base) ?? []
    arr.push(t)
    byBasename.set(base, arr)
  }
  return {
    targets,
    targetSet,
    byBasename,
  }
}

function resolveWritePathToCanonical(
  rawPath: string,
  canonical: CanonicalPathMap,
  workspaceRoot?: string,
): { ok: true; path: string; rewritten: boolean } | { ok: false; reason: string } {
  if (canonical.targets.length === 0) {
    const normalized = normalizeRelativePath(rawPath, workspaceRoot)
    return { ok: true, path: normalized || rawPath, rewritten: false }
  }

  const normalized = normalizeRelativePath(rawPath, workspaceRoot)
  if (!normalized) {
    return { ok: false, reason: "empty write path" }
  }

  if (canonical.targetSet.has(normalized)) {
    return { ok: true, path: normalized, rewritten: normalized !== rawPath }
  }

  const base = normalized.split("/").pop() ?? normalized
  const candidates = canonical.byBasename.get(base) ?? []
  if (candidates.length === 1 && candidates[0]) {
    return { ok: true, path: candidates[0], rewritten: candidates[0] !== rawPath }
  }

  return {
    ok: false,
    reason: `path "${rawPath}" is outside this step's targetArtifacts`,
  }
}

function wrapPlannerChildToolsForWriteScope(tools: readonly Tool[], envelope: ExecutionEnvelope): Tool[] {
  const canonical = buildCanonicalPathMap(envelope.targetArtifacts, envelope.workspaceRoot)

  return tools.map((tool) => {
    if (tool.name !== "write_file" && tool.name !== "replace_in_file") {
      return tool
    }

    return {
      ...tool,
      async execute(args) {
        const rawPath = typeof args?.path === "string" ? args.path : ""
        if (!rawPath) {
          return "Error: WRITE SCOPE VIOLATION — missing path argument"
        }

        const resolved = resolveWritePathToCanonical(rawPath, canonical, envelope.workspaceRoot)
        if (!resolved.ok) {
          return (
            `Error: WRITE SCOPE VIOLATION — ${resolved.reason}. ` +
            `Allowed targetArtifacts for this step: ${canonical.targets.join(", ") || "(none declared)"}. ` +
            `Write was rejected before filesystem mutation.`
          )
        }

        const nextArgs = { ...(args as Record<string, unknown>), path: resolved.path }
        const result = await tool.execute(nextArgs)
        if (resolved.rewritten && typeof result === "string" && !result.startsWith("Error:")) {
          return `${result}\n[canonical-path] Rewrote write path "${rawPath}" -> "${resolved.path}"`
        }
        return result
      },
    }
  })
}

function canonicalizeEnvelope(envelope: ExecutionEnvelope): ExecutionEnvelope {
  const targetArtifacts = canonicalizeArtifacts(envelope.targetArtifacts, envelope.workspaceRoot)
  const targetSet = new Set(targetArtifacts)
  const requiredSourceArtifacts = canonicalizeArtifacts(envelope.requiredSourceArtifacts, envelope.workspaceRoot)
    .map((src) => {
      if (targetSet.has(src)) return src
      const base = src.split("/").pop() ?? src
      const matches = targetArtifacts.filter(t => t.endsWith(`/${base}`) || t === base)
      return matches.length === 1 ? matches[0] : src
    })

  return {
    ...envelope,
    targetArtifacts,
    requiredSourceArtifacts: [...new Set(requiredSourceArtifacts)],
    forbiddenArtifacts: [...new Set(envelope.forbiddenArtifacts ?? [])],
    requiredChecks: [...new Set(envelope.requiredChecks ?? [])],
    upstreamAcceptedArtifacts: [...new Set(envelope.upstreamAcceptedArtifacts ?? [])],
    unresolvedDependencyBlockers: [...new Set(envelope.unresolvedDependencyBlockers ?? [])],
    repairContext: envelope.repairContext
      ? {
        ...envelope.repairContext,
        requiredAcceptedArtifacts: [...new Set(envelope.repairContext.requiredAcceptedArtifacts)],
        unresolvedDependencyBlockers: [...new Set(envelope.repairContext.unresolvedDependencyBlockers)],
      }
      : undefined,
  }
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
): Promise<DelegateResult> {
  const normalizedEnvelope = canonicalizeEnvelope(envelope)

  // Build the child's goal from the step's contract
  // IMPORTANT: Workspace and path context goes FIRST so the child knows
  // where it's working before reading the objective

  const goalParts: string[] = [
    `## Workspace — READ THIS FIRST\nYou are working in: ${normalizedEnvelope.workspaceRoot}\nAll file paths are relative to this directory. Use relative paths (e.g. "tmp/index.html") with read_file/write_file.\nWrite scope: ${normalizedEnvelope.allowedWriteRoots.join(", ") || normalizedEnvelope.workspaceRoot}`,
  ]

  if (normalizedEnvelope.requiredSourceArtifacts.length > 0) {
    goalParts.push(
      `## Source Files — READ THESE FIRST (MANDATORY)\nThese files ALREADY EXIST on disk, created by prior steps. You are BUILDING ON TOP of this work.\nYou MUST read each of these files with read_file BEFORE writing any code.\nDo NOT rewrite or replace these files unless they are also listed in your Target Files.\n${normalizedEnvelope.requiredSourceArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  goalParts.push(`## Objective\n${step.objective}`)

  // If a BLUEPRINT.md is in source artifacts, add an explicit contract enforcement reminder
  const hasBlueprintSource = normalizedEnvelope.requiredSourceArtifacts.some(
    a => /BLUEPRINT\.md$/i.test(a),
  )
  if (hasBlueprintSource) {
    goalParts.push(
      `## BLUEPRINT CONTRACT — MANDATORY\nThe BLUEPRINT.md file in your Source Files defines function signatures AND algorithmic contracts.\nYou MUST implement EVERY case listed in each function's contract. A function named "validateMove" that lists 6 piece types means you implement ALL 6 — not 1-2 with a catch-all return.\nA function named "checkGameStatus" that lists checkmate, stalemate, and draw conditions means you implement ALL of them — not just "return 'ongoing'".\nFailing to implement all contract cases = STUB = REJECTION.`,
    )
  }

  if (step.inputContract) {
    goalParts.push(`## Input Context\n${step.inputContract}`)
  }

  if (step.acceptanceCriteria.length > 0) {
    goalParts.push(
      `## Acceptance Criteria (ALL must be met)\n${step.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    )
  }

  if (normalizedEnvelope.targetArtifacts.length > 0) {
    goalParts.push(
      `## Target Files\nYou are responsible for creating/modifying:\n${normalizedEnvelope.targetArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.upstreamAcceptedArtifacts?.length ?? 0) > 0) {
    goalParts.push(
      `## Accepted Upstream Artifacts\nThese artifacts are already verified and safe to rely on:\n${normalizedEnvelope.upstreamAcceptedArtifacts!.map(a => `- ${a}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.unresolvedDependencyBlockers?.length ?? 0) > 0) {
    goalParts.push(
      `## Dependency Blockers\nDo NOT claim completion for work that depends on these unresolved blockers:\n${normalizedEnvelope.unresolvedDependencyBlockers!.map(item => `- ${item}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.requiredChecks?.length ?? 0) > 0) {
    goalParts.push(
      `## Required Checks Before Completion\nYou must run or reason through these checks before finishing:\n${normalizedEnvelope.requiredChecks!.map(item => `- ${item}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.repairContext?.goals.length ?? 0) > 0 || (normalizedEnvelope.repairContext?.dependencyGoals.length ?? 0) > 0) {
    goalParts.push(
      `## Structured Repair Payload\nMode: ${normalizedEnvelope.repairContext?.mode ?? "initial"}\n` +
      `Owned Repair Goals:\n${(normalizedEnvelope.repairContext?.goals.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.goals.map(goal => `- [${goal.issueCode}] ${goal.summary} (${goal.repairClass}, ${goal.severity}, ${(goal.confidence * 100).toFixed(0)}%, owner=${goal.primaryOwner ?? "none"}, mode=${goal.ownershipMode}, suspects=${goal.suspectedOwners.join(", ") || "none"})`).join("\n")
        : "- none"}\n` +
      `Dependency Context Goals:\n${(normalizedEnvelope.repairContext?.dependencyGoals.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.dependencyGoals.map(goal => `- [${goal.issueCode}] ${goal.summary} (${(goal.confidence * 100).toFixed(0)}%, mode=${goal.ownershipMode}, suspects=${goal.suspectedOwners.join(", ") || "none"})`).join("\n")
        : "- none"}\n` +
      `Required Accepted Artifacts:\n${(normalizedEnvelope.repairContext?.requiredAcceptedArtifacts.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.requiredAcceptedArtifacts.map(artifact => `- ${artifact}`).join("\n")
        : "- none"}`,
    )
  }

  goalParts.push(
    `## Step Contract\n` +
    `Step Name: ${step.name}\n` +
    `Role: ${normalizedEnvelope.role ?? "writer"}\n` +
    `Effect Class: ${normalizedEnvelope.effectClass}\n` +
    `Verification Mode: ${normalizedEnvelope.verificationMode}\n` +
    `Owned Artifacts:\n${normalizedEnvelope.targetArtifacts.map(a => `- ${a}`).join("\n") || "- none"}\n` +
    `Readable Context Artifacts:\n${normalizedEnvelope.requiredSourceArtifacts.map(a => `- ${a}`).join("\n") || "- none"}\n` +
    `Forbidden Writes:\n${(normalizedEnvelope.forbiddenArtifacts?.length ?? 0) > 0
      ? normalizedEnvelope.forbiddenArtifacts!.map(a => `- ${a}`).join("\n")
      : "- any artifact not listed under Owned Artifacts unless explicitly allowed as integration context."}`,
  )

  const goal = goalParts.join("\n\n")

  // Filter tools based on the envelope's allowedTools / requiredToolCapabilities
  let childTools: Tool[]
  const allowedToolNames = new Set([
    ...normalizedEnvelope.allowedTools,
    ...step.requiredToolCapabilities,
  ])

  // Children that write files ALWAYS need read_file + verification tools,
  // even if the LLM plan forgot to list them. Without these the child
  // cannot self-review and gets stuck in write-only loops.
  if (allowedToolNames.size > 0 && normalizedEnvelope.effectClass !== "readonly") {
    for (const essential of ["read_file", "append_file", "replace_in_file", "list_directory", "browser_check", "run_command"]) {
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

  childTools = wrapPlannerChildToolsForWriteScope(childTools, normalizedEnvelope)

  const budgetMetrics = computePlannerChildBudgetMetrics(step, normalizedEnvelope)
  const maxIter = budgetMetrics.computedMaxIterations

  ctx.onChildTrace?.({
    kind: "planner-delegation-start",
    goal: step.objective,
    stepName: step.name,
    depth: ctx.depth + 1,
    tools: childTools.map(t => t.name),
    budget: budgetMetrics,
    envelope: {
        workspaceRoot: normalizedEnvelope.workspaceRoot,
        effectClass: normalizedEnvelope.effectClass,
        verificationMode: normalizedEnvelope.verificationMode,
        targetArtifacts: normalizedEnvelope.targetArtifacts,
      upstreamAcceptedArtifacts: normalizedEnvelope.upstreamAcceptedArtifacts,
      unresolvedDependencyBlockers: normalizedEnvelope.unresolvedDependencyBlockers,
      repairContext: normalizedEnvelope.repairContext,
    },
  })

  let releaseSlot: (() => void) | undefined
  if (ctx.acquireSlot) {
    const childRunId = `plan-${step.name}-${Date.now()}`
    releaseSlot = await ctx.acquireSlot(childRunId)
  }

  // Buffer LLM request/response events so they emit AFTER the iteration marker
  let pendingPlannerLlmEvents: Record<string, unknown>[] = []

  // ── Build completion validator for code quality gate ──
  // When the child tries to exit, read ALL target artifacts and run stub
  // detection. If stubs remain, force the child to keep working.
  const targetArtifacts = normalizedEnvelope.targetArtifacts
  const wsRoot = normalizedEnvelope.workspaceRoot
  const completionValidator = targetArtifacts.length > 0 ? async (): Promise<string | null> => {
    const codeArtifacts = targetArtifacts.filter(
      a => /\.(js|jsx|ts|tsx|py|rb|java|cs|go|rs)$/i.test(a),
    )
    if (codeArtifacts.length === 0) return null

    const allIssues: string[] = []
    for (const artifact of codeArtifacts) {
      const fullPath = pathResolve(wsRoot, artifact)
      try {
        const content = await fsReadFile(fullPath, "utf-8")
        const findings = detectPlaceholderPatterns(content)
        for (const f of findings) {
          allIssues.push(`${artifact}: ${f}`)
        }
      } catch { /* file not created yet or unreadable */ }
    }

    if (allIssues.length > 0) {
      return (
        `COMPLETION CHECK FAILED — your code still contains stub/placeholder functions:\n` +
        allIssues.map(i => `  - ${i}`).join("\n") + "\n\n" +
        `You MUST fix these before finishing. For EACH stub function:\n` +
        `1. The function name tells you what it should do — implement the REAL algorithm\n` +
        `2. Replace the stub body (return true/false/[]/{}/ or comment-only) with working logic\n` +
        `3. A function called "validateInput" must enforce all required validation rules\n` +
        `4. A function called "computeResult" must execute the full required business logic\n` +
        `Do NOT provide a final answer until ALL stubs are replaced with real code.`
      )
    }
    return null
  } : undefined

  const child = new Agent(ctx.llm, childTools, {
    maxIterations: maxIter,
    systemPrompt: CHILD_SYSTEM_PROMPT,
    verbose: false,
    signal: ctx.signal,
    deferRecoveryHintsUntilCompletionAttempt: true,
    completionValidator,
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
      const execution = buildChildExecutionResult(answer, child.allToolCalls)
      return {
        output: `⚠ DELEGATION INCOMPLETE — child agent for step "${step.name}" used all ${maxIter} iterations without finishing.\nChild's last output: ${answer}`,
        toolCalls: child.allToolCalls,
        execution,
      }
    }

    return {
      output: answer,
      toolCalls: child.allToolCalls,
      execution: buildChildExecutionResult(answer, child.allToolCalls),
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    ctx.onChildTrace?.({
      kind: "planner-delegation-end",
      stepName: step.name,
      depth: ctx.depth + 1,
      status: "error",
      error: errMsg,
    })
    const output = `Delegation failed: ${errMsg}`
    return {
      output,
      toolCalls: child.allToolCalls,
      execution: buildChildExecutionResult(output, child.allToolCalls),
    }
  } finally {
    releaseSlot?.()
  }
}
