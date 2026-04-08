/**
 * Plan generation — ask the LLM to decompose a complex task into a structured plan.
 *
 * The LLM is called in "planner mode" with a special system prompt that instructs
 * it to output a JSON plan with deterministic_tool and subagent_task steps.
 *
 * Inspired by agenc-core's buildPlannerMessages + parsePlannerPlan.
 *
 * @module
 */

import type { LLMClient, Message, Tool } from "../types.js"
import type { DeterministicToolStep, Plan, PlanDiagnostic, PlanEdge, PlanStep, SubagentTaskStep } from "./types.js"

// ============================================================================
// Planner system prompt
// ============================================================================

const PLANNER_SYSTEM_PROMPT = `You are a task decomposition planner. Your job is to break a complex task into a structured execution plan.

You MUST respond with valid JSON matching this schema:

{
  "reason": "Brief explanation of your decomposition strategy",
  "confidence": 0.85,
  "requiresSynthesis": false,
  "steps": [...],
  "edges": [...]
}

## Step Types

### 1. deterministic_tool — An exact tool call with known arguments
{
  "name": "unique_step_id",
  "stepType": "deterministic_tool",
  "dependsOn": [],
  "tool": "tool_name",
  "args": { "key": "value" },
  "onError": "retry",
  "maxRetries": 2
}

### 2. subagent_task — Complex work delegated to a child agent
{
  "name": "unique_step_id",
  "stepType": "subagent_task",
  "dependsOn": [],
  "objective": "What the child must accomplish — specific and measurable",
  "inputContract": "What context/inputs are available to the child",
  "acceptanceCriteria": [
    "Measurable success condition 1 — must be concrete and verifiable, e.g. 'pieces move according to chess rules' NOT 'game logic is implemented'",
    "Measurable success condition 2 — must describe FUNCTIONAL behavior, not just file existence"
  ],
  "requiredToolCapabilities": ["write_file", "run_command", "read_file"],
  "contextRequirements": ["needs workspace context", "needs dependency outputs"],
  "executionContext": {
    "workspaceRoot": "/path/to/workspace",
    "allowedReadRoots": ["/path/to/workspace"],
    "allowedWriteRoots": ["/path/to/workspace"],
    "allowedTools": ["write_file", "read_file", "run_command", "browser_check"],
    "requiredSourceArtifacts": [],
    "targetArtifacts": ["index.html", "styles.css"],
    "effectClass": "filesystem_write",
    "verificationMode": "browser_check",
    "artifactRelations": [
      { "relationType": "write_owner", "artifactPath": "styles.css" }
    ]
  },
  "maxBudgetHint": "20 iterations",
  "canRunParallel": false,
  "workflowStep": {
    "role": "writer",
    "artifactRelations": [
      { "relationType": "write_owner", "artifactPath": "styles.css" }
    ]
  }
}

## Edges — dependency links between steps
{
  "from": "step_a",
  "to": "step_b"
}

## Rules
1. Every subagent_task MUST have specific, measurable acceptanceCriteria — never vague
2. Each subagent_task MUST declare which tools it needs in requiredToolCapabilities  
3. Exactly ONE step may be "write_owner" for a given artifact — no shared writes. If step B writes to a file that step A created, only step B should be write_owner and step A should either not list that artifact or use "read_dependency"
4. Steps that can run independently SHOULD have canRunParallel: true
5. SCOPE EACH STEP TO BE COMPLETABLE IN ITS BUDGET. A child agent gets ~20 iterations (tool calls). Each step should be scoped so a competent developer could complete it in that many actions. If a task is too complex for one step (e.g. "build a full chess engine"), split it into focused sub-steps — e.g. one step for core move logic, another for check/checkmate detection, another for the UI. Prefer 3-7 steps. Under-decomposition is worse than over-decomposition.
6. DO NOT add a separate "final_verification" or "verify" deterministic_tool step that calls browser_check. Verification is handled AUTOMATICALLY by the system after the pipeline finishes. Instead, set verificationMode on the subagent_task steps that produce verifiable output (e.g. verificationMode: "browser_check" for HTML). Adding a redundant verification step wastes budget and fails because the system verifier runs separately.
7. workspaceRoot should match the actual working directory
8. DO NOT produce plans with only read/analysis steps — if the task asks to BUILD something, include write steps
9. Each step name must be unique across the plan
10. VERIFICATION REQUIRED: If ANY step writes files (effectClass != "readonly"), at least ONE subagent_task step MUST have verificationMode set to "browser_check", "run_tests", or "deterministic_followup" — never leave ALL steps with verificationMode: "none" when there are writes
11. MODULAR FILE ARCHITECTURE — MANDATORY: A single child agent MUST NOT write files >200 lines of logic. When the total code exceeds ~200 lines, the plan MUST structure targetArtifacts as MULTIPLE small files (<200 lines each) — NOT one monolithic file. For example, a chess game is NOT one script.js — it is board.js (~80 lines), rules.js (~150 lines), game.js (~120 lines), ui.js (~100 lines), index.html, and styles.css. Each step's targetArtifacts should list these smaller files. The child's objective MUST specify which files to create and what each file is responsible for. Browser projects use \`<script src="file.js">\` tags in dependency order, sharing state via globals.
12. IMPLEMENTATION COMPLETENESS: Every step objective MUST specify that REAL, COMPLETE logic is required — not scaffolding, not placeholders, not stubs. For example, "implement chess move validation" means every piece type has real movement rules, not \`isValidMove() { return true }\`. The verifier WILL read the output files and flag any placeholder patterns (\`return true\` as validation, \`// TODO\`, empty function bodies). Such findings force a retry.
13. acceptanceCriteria MUST describe FUNCTIONAL behavior ("pawns can only move forward", "clicking a piece highlights legal moves") NOT structural facts ("file exists", "function is defined"). The verifier uses these criteria to judge real quality.
14. MINIMIZE FILE CONFLICTS: If multiple fixes/changes target the SAME file, COMBINE them into ONE step when possible. Each time a file is rewritten by a different step, ALL previous changes to that file risk being lost (because write_file replaces the entire file). Splitting "fix bug A in file.js" and "fix bug B in file.js" into separate steps is DANGEROUS — the second step's rewrite will likely overwrite bug-A's fix. Instead combine: "fix bugs A and B in file.js" as a single step. Only split into separate steps when the changes are truly independent files.
15. EACH FILE WRITTEN COMPLETELY IN ONE PASS: A step's objective MUST instruct the child to write each target file's COMPLETE implementation in a single write_file call — not incrementally. The child should plan (using the think tool) what ALL functions in each file will be, then write the entire file at once. Incremental rewrites (write skeleton → add feature → add feature) cause function loss and degeneration. One-shot writes do not.
16. USE replace_in_file FOR FIXES: If a retry step needs to fix specific functions in an existing file, the objective MUST say to use replace_in_file (surgical section replacement) rather than rewriting the entire file with write_file. This prevents function loss during corrections.
17. NO "FINALIZE/INTEGRATE" STEPS THAT MODIFY OTHER STEPS' FILES: NEVER create a "finalize_and_test" or "integration" step that REWRITES files created by earlier steps. Each step is a separate process with no memory — a "finalize" step WILL overwrite earlier steps' work and lose their implementations. If you need testing/verification, set verificationMode on the producing step itself. If you need cross-file wiring (e.g., adding script tags to HTML), the HTML-creating step should already include ALL script tags, OR the last code-writing step should own the HTML file too.
19. HTML MUST LOAD ALL SCRIPTS — MANDATORY: For browser projects, the step that creates the HTML file MUST include \`<script src="filename.js">\` tags for EVERY JS file in the plan. The HTML step's objective MUST explicitly list every script tag to add. If the HTML is created before the JS files, the script tags still MUST be present (the browser will load them when the files exist). The verifier WILL check that HTML files reference all JS artifacts and flag missing script tags as an integration failure.
20. targetArtifacts MUST be FILE PATHS only: Every entry in targetArtifacts must be a valid file path (e.g. "game/board.js"). NEVER put CSS selectors (".square.light"), DOM queries, URLs, or other non-path values in targetArtifacts.
18. ONE OWNER PER FILE — STRICT: Every file appears in targetArtifacts of EXACTLY ONE step. No file should be written by multiple steps. If step A creates game_logic.js, NO other step may have game_logic.js in its targetArtifacts. A step that needs to READ another step's file puts it in requiredSourceArtifacts (read-only), not targetArtifacts. Violating this WILL cause destructive overwrites.
21. SHARED DATA CONTRACT — MANDATORY FOR MULTI-FILE PROJECTS: When multiple JS files need to share data structures (game state, board representation, app state), the FIRST step's objective MUST define the EXACT data format. Example: "Board cells use the format { type: 'pawn', color: 'white' }. The board is a 2D array: board[row][col]." ALL subsequent steps' objectives MUST reference this same format verbatim. Without a shared contract, each child invents its own format and the files are INCOMPATIBLE.
22. WRITE SCOPE — STRICT: Each child agent MUST ONLY write to files listed in its targetArtifacts. The child MUST NOT create placeholder/stub files for other steps' artifacts. If step A owns index.html and step B owns game.js, step A MUST NOT create an empty game.js "for later" — this confuses step B and causes path/content conflicts. Each step writes ONLY its own files.

## CRITICAL: File Paths and Artifact Chains
- ALL paths in targetArtifacts and requiredSourceArtifacts MUST be relative to workspace root (e.g. "src/app.js", "game/index.html")
- ALL steps in a plan MUST use the SAME output directory. If step 1 creates "tmp/game/index.html", ALL other steps MUST also put files in "tmp/game/" — NEVER in "game/" or the root. The full directory prefix (including ALL parent directories like "tmp/game/") must be preserved in every path. This is the most critical rule — inconsistent paths cause children to create duplicate files in wrong directories.
- Each child agent is a SEPARATE process with NO memory of other steps. It does NOT see what other steps did unless artifacts are declared in requiredSourceArtifacts.
- If step A creates "game/index.html" and step B needs to modify it, step B MUST list "game/index.html" in requiredSourceArtifacts so the child knows to read it first.
- Use CONSISTENT paths: if step 1 creates "game/index.html", every later step that touches that file must reference "game/index.html" — not "index.html" and not an absolute path.
- Each step's objective MUST mention the EXACT file paths it should create or modify.
- Do NOT create a separate "mkdir" setup step — write_file auto-creates parent directories. Let the first writer step create the directory structure naturally.
- There is NO shared memory between steps. The ONLY way to pass context is through files on disk.
- NEVER use absolute paths in targetArtifacts or requiredSourceArtifacts. Always use workspace-relative paths.

Respond ONLY with the JSON plan object. No markdown, no explanation outside the JSON.`

// ============================================================================
// Plan generation
// ============================================================================

export interface PlanGenerationContext {
  /** The user's original task/goal. */
  readonly goal: string
  /** Available tools the children can use. */
  readonly availableTools: readonly Tool[]
  /** Current working directory / workspace root. */
  readonly workspaceRoot: string
  /** Conversation history for context. */
  readonly history: readonly Message[]
}

export interface PlanGenerationResult {
  readonly plan: Plan | null
  readonly diagnostics: readonly PlanDiagnostic[]
  /** Raw LLM response for debugging. */
  readonly rawResponse: string | null
}

/**
 * Ask the LLM to generate a structured execution plan for a complex task.
 *
 * Returns the parsed plan or diagnostics explaining why parsing failed.
 * Supports up to `maxAttempts` refinement passes if the plan is invalid.
 */
export async function generatePlan(
  llm: LLMClient,
  ctx: PlanGenerationContext,
  opts?: { maxAttempts?: number; signal?: AbortSignal },
): Promise<PlanGenerationResult> {
  const maxAttempts = opts?.maxAttempts ?? 3
  const diagnostics: PlanDiagnostic[] = []
  let refinementHint: string | null = null

  const toolDescriptions = ctx.availableTools
    .filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n")

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages: Message[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "system",
        content: `Available tools for children:\n${toolDescriptions}\n\nWorkspace root: ${ctx.workspaceRoot}`,
      },
    ]

    // Add recent history for context (limit to last 10 messages)
    const recentHistory = ctx.history.slice(-10).filter(
      m => m.role === "user" || m.role === "assistant",
    )
    if (recentHistory.length > 0) {
      messages.push({
        role: "system",
        content: `Recent conversation context:\n${recentHistory.map(m => `[${m.role}]: ${(m.content ?? "").slice(0, 500)}`).join("\n")}`,
      })
    }

    // Add refinement hint from previous failed attempt
    if (refinementHint) {
      messages.push({
        role: "system",
        content: `REFINEMENT REQUIRED: Your previous plan had issues. Fix them:\n${refinementHint}`,
      })
    }

    messages.push({ role: "user", content: ctx.goal })

    let rawResponse: string | null = null
    try {
      const response = await llm.chat(messages, [], { signal: opts?.signal })
      rawResponse = response.content

      if (!rawResponse) {
        diagnostics.push({
          category: "parse", severity: "error",
          code: "empty_response",
          message: "Planner returned empty response",
          details: { attempt },
        })
        refinementHint = "You returned an empty response. Respond with a valid JSON plan object."
        continue
      }

      // Parse the JSON plan
      const parsed = parsePlanFromResponse(rawResponse)
      if (!parsed.plan) {
        // agenc-core pattern: attempt to salvage a plan from partial/malformed response
        const salvaged = salvagePlanFromMalformedResponse(rawResponse, ctx.workspaceRoot)
        if (salvaged) {
          diagnostics.push({
            category: "parse", severity: "error",
            code: "salvaged_from_malformed",
            message: "Plan was salvaged from malformed planner response",
            details: { attempt },
          })
          return { plan: normalizeWorkspaceRoots(salvaged, ctx.workspaceRoot), diagnostics, rawResponse }
        }

        diagnostics.push(...parsed.diagnostics)
        refinementHint = parsed.diagnostics.map(d => d.message).join("\n")
        continue
      }

      // Post-process: normalize workspaceRoot in all execution contexts
      // to match the actual workspace root (don't trust LLM-generated paths)
      const normalizedPlan = normalizeWorkspaceRoots(parsed.plan, ctx.workspaceRoot)

      return { plan: normalizedPlan, diagnostics, rawResponse }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      diagnostics.push({
        category: "parse", severity: "error",
        code: "llm_error",
        message: `LLM call failed: ${errMsg}`,
        details: { attempt },
      })

      // Abort errors should not be retried
      if (opts?.signal?.aborted || errMsg.includes("abort")) {
        return { plan: null, diagnostics, rawResponse }
      }

      // Transient network errors (fetch failed, timeout, etc.) — retry
      const isTransient = /fetch failed|timeout|timed out|econnreset|econnrefused|socket hang up|network|429|502|503/i.test(errMsg)
      if (!isTransient) {
        return { plan: null, diagnostics, rawResponse }
      }
      // Let loop continue to next attempt
      refinementHint = null
    }
  }

  return { plan: null, diagnostics, rawResponse: null }
}

// ============================================================================
// Workspace root normalization
// ============================================================================

/**
 * Override LLM-generated workspaceRoot values in all execution contexts
 * with the actual workspace root. The LLM often gets paths wrong (uses ".",
 * relative paths, or host paths that don't match the container).
 */
function normalizeWorkspaceRoots(plan: Plan, actualRoot: string): Plan {
  const normalizedSteps: PlanStep[] = plan.steps.map(step => {
    if (step.stepType !== "subagent_task") return step

    const sa = step as SubagentTaskStep
    // Strip trailing slashes to prevent double-prefixing (e.g. "tmp/" + "/" + "tmp/file" → "tmp//tmp/file")
    const originalRoot = sa.executionContext.workspaceRoot.replace(/\/+$/, "")

    // If the LLM generated a relative workspaceRoot (e.g. "tmp", "game/src"),
    // targetArtifacts and other paths are relative to THAT subdirectory.
    // When we replace workspaceRoot with the actual root, we must prefix those
    // paths so they remain correct.
    const needsPrefix = originalRoot
      && originalRoot !== "."
      && originalRoot !== ""
      && !originalRoot.startsWith("/")
      && originalRoot !== actualRoot

    const prefixPath = (p: string): string => {
      if (!needsPrefix) return p
      // Don't double-prefix if already starts with the original root
      if (p.startsWith(originalRoot + "/") || p === originalRoot) return p
      // Don't prefix absolute paths
      if (p.startsWith("/")) return p
      return `${originalRoot}/${p}`
    }

    return {
      ...sa,
      executionContext: {
        ...sa.executionContext,
        workspaceRoot: actualRoot,
        allowedReadRoots: sa.executionContext.allowedReadRoots.map(r =>
          r === "." || r === "./" ? actualRoot : r,
        ),
        allowedWriteRoots: sa.executionContext.allowedWriteRoots.map(r =>
          r === "." || r === "./" ? actualRoot : r,
        ),
        targetArtifacts: sa.executionContext.targetArtifacts.map(prefixPath),
        requiredSourceArtifacts: sa.executionContext.requiredSourceArtifacts.map(prefixPath),
        artifactRelations: sa.executionContext.artifactRelations.map(rel => ({
          ...rel,
          artifactPath: prefixPath(rel.artifactPath),
        })),
      },
      // Also fix workflowStep artifact relations if present
      ...(sa.workflowStep ? {
        workflowStep: {
          ...sa.workflowStep,
          artifactRelations: sa.workflowStep.artifactRelations.map(rel => ({
            ...rel,
            artifactPath: prefixPath(rel.artifactPath),
          })),
        },
      } : {}),
    }
  })

  return { ...plan, steps: normalizedSteps }
}

// ============================================================================
// Plan salvage from malformed responses (agenc-core pattern)
// ============================================================================

/**
 * When the planner returns something that can't parse as a full plan,
 * try to extract any usable file-write or tool-call info and salvage it
 * into a minimal single-step plan. This prevents total failure when the
 * planner's JSON is slightly malformed or wrapped in prose.
 */
function salvagePlanFromMalformedResponse(raw: string, _workspaceRoot: string): Plan | null {
  // Try harder: find any JSON object buried in the response
  const jsonMatches = raw.match(/\{[\s\S]*?"steps"\s*:\s*\[[\s\S]*?\]\s*[\s\S]*?\}/g)
  if (jsonMatches) {
    for (const candidate of jsonMatches) {
      try {
        const obj = JSON.parse(candidate) as Record<string, unknown>
        if (Array.isArray(obj.steps) && obj.steps.length > 0) {
          const inner = parsePlanFromResponse(candidate)
          if (inner.plan) return inner.plan
        }
      } catch { /* skip */ }
    }
  }

  return null
}

// ============================================================================
// Plan parsing
// ============================================================================

function parsePlanFromResponse(raw: string): {
  plan: Plan | null
  diagnostics: PlanDiagnostic[]
} {
  const diagnostics: PlanDiagnostic[] = []

  // Extract JSON from markdown code blocks if present
  let jsonStr = raw.trim()
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1].trim()
  }

  let obj: unknown
  try {
    obj = JSON.parse(jsonStr)
  } catch {
    diagnostics.push({
      category: "parse", severity: "error",
      code: "invalid_json",
      message: "Response is not valid JSON. Respond with ONLY a JSON object, no markdown.",
    })
    return { plan: null, diagnostics }
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    diagnostics.push({
      category: "parse", severity: "error",
      code: "not_object",
      message: "Response must be a JSON object with { reason, steps, edges }.",
    })
    return { plan: null, diagnostics }
  }

  const data = obj as Record<string, unknown>

  // Validate required fields
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    diagnostics.push({
      category: "parse", severity: "error",
      code: "missing_steps",
      message: "Plan must have a non-empty 'steps' array.",
    })
    return { plan: null, diagnostics }
  }

  // Parse steps
  const steps: PlanStep[] = []
  const stepNames = new Set<string>()
  for (let i = 0; i < data.steps.length; i++) {
    const raw = data.steps[i] as Record<string, unknown>
    if (!raw || typeof raw !== "object") {
      diagnostics.push({
        category: "parse", severity: "error",
        code: "invalid_step",
        message: `Step ${i} is not an object.`,
      })
      return { plan: null, diagnostics }
    }

    const name = String(raw.name ?? `step_${i}`)
    if (stepNames.has(name)) {
      diagnostics.push({
        category: "graph", severity: "error",
        code: "duplicate_step_name",
        message: `Duplicate step name "${name}". Each step must have a unique name.`,
      })
      return { plan: null, diagnostics }
    }
    stepNames.add(name)

    const stepType = String(raw.stepType ?? "")
    if (stepType === "deterministic_tool") {
      steps.push(parseDeterministicStep(name, raw))
    } else if (stepType === "subagent_task") {
      const parsed = parseSubagentStep(name, raw)
      if (parsed.diagnostics.length > 0) {
        diagnostics.push(...parsed.diagnostics)
        return { plan: null, diagnostics }
      }
      steps.push(parsed.step!)
    } else {
      diagnostics.push({
        category: "parse", severity: "error",
        code: "unknown_step_type",
        message: `Step "${name}" has unknown stepType "${stepType}". Must be "deterministic_tool" or "subagent_task".`,
      })
      return { plan: null, diagnostics }
    }
  }

  // Parse edges
  const edges: PlanEdge[] = []
  if (Array.isArray(data.edges)) {
    for (const e of data.edges) {
      const edge = e as Record<string, unknown>
      const from = String(edge.from ?? "")
      const to = String(edge.to ?? "")
      if (!stepNames.has(from)) {
        diagnostics.push({
          category: "graph", severity: "error",
          code: "edge_unknown_source",
          message: `Edge from "${from}" → "${to}": source step "${from}" not found.`,
        })
        continue
      }
      if (!stepNames.has(to)) {
        diagnostics.push({
          category: "graph", severity: "error",
          code: "edge_unknown_target",
          message: `Edge from "${from}" → "${to}": target step "${to}" not found.`,
        })
        continue
      }
      edges.push({ from, to })
    }
  }

  // Also collect edges from dependsOn fields
  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!stepNames.has(dep)) {
          diagnostics.push({
            category: "graph", severity: "error",
            code: "dependency_not_found",
            message: `Step "${step.name}" depends on "${dep}", which doesn't exist.`,
          })
        } else if (!edges.some(e => e.from === dep && e.to === step.name)) {
          edges.push({ from: dep, to: step.name })
        }
      }
    }
  }

  // Auto-fix: ensure artifact paths include the output directory prefix.
  // The LLM often puts "game_logic.js" in targetArtifacts while the objective
  // says "write to tmp/game_logic.js" — causing the verifier to look in the
  // wrong place. Detect the common output directory from objectives and fix paths.
  normalizeArtifactDirectories(steps)

  // Auto-fix: ensure verification coverage on write plans
  ensureVerificationCoverage(steps)

  // Auto-fix: deduplicate write ownership per artifact
  deduplicateWriteOwnership(steps)

  // Auto-fix: strip redundant verification deterministic_tool steps.
  // The system verifier runs automatically; planner-generated browser_check
  // deterministic steps are redundant and fail (wrong arg names, path issues).
  stripRedundantVerificationSteps(steps, edges)

  const plan: Plan = {
    reason: String(data.reason ?? "planner_generated"),
    confidence: typeof data.confidence === "number" ? data.confidence : undefined,
    requiresSynthesis: Boolean(data.requiresSynthesis),
    steps,
    edges,
  }

  return { plan, diagnostics }
}

function parseDeterministicStep(
  name: string,
  raw: Record<string, unknown>,
): DeterministicToolStep {
  return {
    name,
    stepType: "deterministic_tool",
    dependsOn: safeStringArray(raw.dependsOn),
    tool: String(raw.tool ?? ""),
    args: (typeof raw.args === "object" && raw.args !== null && !Array.isArray(raw.args))
      ? raw.args as Record<string, unknown>
      : {},
    onError: raw.onError === "skip" ? "skip" : raw.onError === "abort" ? "abort" : "retry",
    maxRetries: typeof raw.maxRetries === "number" ? raw.maxRetries : 2,
  }
}

function parseSubagentStep(
  name: string,
  raw: Record<string, unknown>,
): { step: SubagentTaskStep | null; diagnostics: PlanDiagnostic[] } {
  const diagnostics: PlanDiagnostic[] = []

  if (!raw.objective || typeof raw.objective !== "string") {
    diagnostics.push({
      category: "contract", severity: "error",
      code: "missing_objective",
      message: `Subagent step "${name}" must have a string 'objective'.`,
    })
    return { step: null, diagnostics }
  }

  const acceptanceCriteria = safeStringArray(raw.acceptanceCriteria)
  if (acceptanceCriteria.length === 0) {
    diagnostics.push({
      category: "contract", severity: "error",
      code: "missing_acceptance_criteria",
      message: `Subagent step "${name}" must have non-empty 'acceptanceCriteria' array.`,
    })
    return { step: null, diagnostics }
  }

  const execCtx = raw.executionContext as Record<string, unknown> | undefined
  const executionContext = execCtx ? {
    workspaceRoot: String(execCtx.workspaceRoot ?? "."),
    allowedReadRoots: safeStringArray(execCtx.allowedReadRoots),
    allowedWriteRoots: safeStringArray(execCtx.allowedWriteRoots),
    allowedTools: safeStringArray(execCtx.allowedTools),
    requiredSourceArtifacts: safeStringArray(execCtx.requiredSourceArtifacts),
    targetArtifacts: safeStringArray(execCtx.targetArtifacts).filter(isValidArtifactPath),
    effectClass: parseEffectClass(execCtx.effectClass),
    verificationMode: parseVerificationMode(execCtx.verificationMode),
    artifactRelations: parseArtifactRelations(execCtx.artifactRelations),
  } : {
    workspaceRoot: ".",
    allowedReadRoots: ["."],
    allowedWriteRoots: ["."],
    allowedTools: [],
    requiredSourceArtifacts: [],
    targetArtifacts: [],
    effectClass: "filesystem_write" as const,
    verificationMode: "none" as const,
    artifactRelations: [],
  }

  const ws = raw.workflowStep as Record<string, unknown> | undefined

  const step: SubagentTaskStep = {
    name,
    stepType: "subagent_task",
    dependsOn: safeStringArray(raw.dependsOn),
    objective: String(raw.objective),
    inputContract: String(raw.inputContract ?? ""),
    acceptanceCriteria,
    requiredToolCapabilities: safeStringArray(raw.requiredToolCapabilities),
    contextRequirements: safeStringArray(raw.contextRequirements),
    executionContext,
    maxBudgetHint: String(raw.maxBudgetHint ?? "20 iterations"),
    canRunParallel: Boolean(raw.canRunParallel),
    workflowStep: ws ? {
      role: parseStepRole(ws.role),
      artifactRelations: parseArtifactRelations(ws.artifactRelations),
    } : undefined,
  }

  return { step, diagnostics }
}

// ============================================================================
// Parse helpers
// ============================================================================

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
}

/** Reject non-file-path entries that the LLM sometimes puts in targetArtifacts (CSS selectors, URLs, bare words). */
export function isValidArtifactPath(path: string): boolean {
  // CSS selectors: start with . or # and don't contain /
  if (/^[.#]/.test(path) && !path.includes("/")) return false
  // Must look like a file path (contain a dot with extension, or contain a /)
  if (!path.includes("/") && !path.includes(".")) return false
  return true
}

function parseEffectClass(value: unknown): "readonly" | "filesystem_write" | "filesystem_scaffold" | "shell" | "mixed" {
  const s = String(value ?? "")
  if (s === "readonly" || s === "filesystem_write" || s === "filesystem_scaffold" || s === "shell" || s === "mixed") {
    return s
  }
  return "filesystem_write"
}

function parseVerificationMode(value: unknown): "none" | "browser_check" | "run_tests" | "mutation_required" | "deterministic_followup" {
  const s = String(value ?? "")
  if (s === "none" || s === "browser_check" || s === "run_tests" || s === "mutation_required" || s === "deterministic_followup") {
    return s
  }
  return "none"
}

function parseStepRole(value: unknown): "writer" | "reviewer" | "validator" | "grounding" {
  const s = String(value ?? "")
  if (s === "writer" || s === "reviewer" || s === "validator" || s === "grounding") {
    return s
  }
  return "writer"
}

function parseArtifactRelations(value: unknown): Array<{ relationType: "read_dependency" | "write_owner"; artifactPath: string }> {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map(v => ({
      relationType: v.relationType === "write_owner" ? "write_owner" as const : "read_dependency" as const,
      artifactPath: String(v.artifactPath ?? ""),
    }))
    .filter(r => r.artifactPath.length > 0)
}

// ============================================================================
// Auto-fix: normalise artifact directory prefixes
// ============================================================================

/**
 * The LLM often generates targetArtifacts without the output-directory prefix
 * even though the child should write to a subdirectory. Two detection strategies:
 *
 * 1. If allowedWriteRoots specifies a subdirectory of workspaceRoot, and
 *    targetArtifacts are bare filenames, prefix them with that subdirectory.
 *
 * 2. Scan objective + acceptanceCriteria for paths like "dir/filename" where
 *    the filename matches a targetArtifact.
 */
function normalizeArtifactDirectories(steps: PlanStep[]): void {
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const ctx = sa.executionContext
    if (!ctx?.targetArtifacts?.length) continue

    const newArtifacts = [...ctx.targetArtifacts]
    const newRelations = ctx.artifactRelations ? [...ctx.artifactRelations] : undefined
    let changed = false

    // Strategy 1: derive prefix from allowedWriteRoots
    // If there's exactly one write root that is a subdirectory of workspaceRoot,
    // use it as the prefix for bare-filename artifacts.
    let writePrefix: string | null = null
    if (ctx.allowedWriteRoots?.length) {
      const wsRoot = ctx.workspaceRoot.replace(/\/$/, "")
      for (const wr of ctx.allowedWriteRoots) {
        const norm = wr.replace(/\/$/, "")
        if (norm !== wsRoot && norm !== "." && norm !== "./" && norm.startsWith(wsRoot + "/")) {
          // e.g. wsRoot="/Users/x/project", wr="/Users/x/project/tmp" → prefix="tmp"
          writePrefix = norm.slice(wsRoot.length + 1)
          break
        }
        // Also handle relative paths like "tmp"
        if (!norm.startsWith("/") && norm !== "." && norm !== "./") {
          writePrefix = norm
          break
        }
      }
    }

    if (writePrefix) {
      for (let i = 0; i < newArtifacts.length; i++) {
        const art = newArtifacts[i]
        if (!art.includes("/")) {
          const prefixed = `${writePrefix}/${art}`
          newArtifacts[i] = prefixed
          changed = true
          if (newRelations) {
            for (let ri = 0; ri < newRelations.length; ri++) {
              if (newRelations[ri].artifactPath === art) {
                newRelations[ri] = { ...newRelations[ri], artifactPath: prefixed }
              }
            }
          }
        }
      }
    }

    // Strategy 2: scan objective text for "dir/filename" patterns
    if (!changed) {
      const textBlob = [
        sa.objective ?? "",
        ...(sa.acceptanceCriteria ?? []),
      ].join(" ")

      for (let i = 0; i < newArtifacts.length; i++) {
        const art = newArtifacts[i]
        if (art.includes("/")) continue
        const escaped = art.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const m = textBlob.match(new RegExp(`(\\b[\\w.-]+/)${escaped}\\b`))
        if (m) {
          const prefixed = m[1] + art
          newArtifacts[i] = prefixed
          changed = true
          if (newRelations) {
            for (let ri = 0; ri < newRelations.length; ri++) {
              if (newRelations[ri].artifactPath === art) {
                newRelations[ri] = { ...newRelations[ri], artifactPath: prefixed }
              }
            }
          }
        }
      }
    }

    if (changed) {
      const newCtx = {
        ...ctx,
        targetArtifacts: newArtifacts,
        ...(newRelations ? { artifactRelations: newRelations } : {}),
      }
      steps[si] = { ...sa, executionContext: newCtx } as SubagentTaskStep
    }
  }
}

// ============================================================================
// Auto-fix: deduplicate write ownership
// ============================================================================

/**
 * If multiple steps claim write_owner on the same artifact, keep only the
 * last one in step order (the downstream implementor) and downgrade earlier
 * ones to read_dependency. This prevents the multiple_write_owners
// ============================================================================
// Auto-fix: strip redundant verification deterministic_tool steps
// ============================================================================

/**
 * Remove deterministic_tool steps that just call browser_check or similar
 * verification tools. The system verifier handles this automatically after
 * the pipeline finishes. Planner-generated verification steps are redundant,
 * waste an iteration, and often fail due to incorrect parameter names.
 */
function stripRedundantVerificationSteps(steps: PlanStep[], edges: PlanEdge[]): void {
  const verifyToolNames = new Set(["browser_check"])
  const toRemove = new Set<string>()

  for (const step of steps) {
    if (step.stepType === "deterministic_tool") {
      const dt = step as DeterministicToolStep
      if (verifyToolNames.has(dt.tool)) {
        toRemove.add(step.name)
      }
    }
  }

  if (toRemove.size === 0) return

  // Remove the steps
  for (let i = steps.length - 1; i >= 0; i--) {
    if (toRemove.has(steps[i].name)) {
      steps.splice(i, 1)
    }
  }

  // Remove edges referencing removed steps
  for (let i = edges.length - 1; i >= 0; i--) {
    if (toRemove.has(edges[i].from) || toRemove.has(edges[i].to)) {
      edges.splice(i, 1)
    }
  }

  // Clean up dependsOn references
  for (const step of steps) {
    if (step.dependsOn) {
      const filtered = step.dependsOn.filter(d => !toRemove.has(d))
      ;(step as unknown as { dependsOn: string[] }).dependsOn = filtered
    }
  }
}

// ============================================================================
// Auto-fix: write ownership deduplication
// ============================================================================

/**
 * If multiple steps claim "write_owner" for the same artifact, keep only
 * the LAST one (which will overwrite) and downgrade earlier ones to
 * "read_dependency". This prevents the duplicate_write_owner
 * validation failure when the LLM duplicates ownership.
 */
function deduplicateWriteOwnership(steps: PlanStep[]): void {
  const subagentSteps = steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  // Collect all write_owner claims per artifact → ordered list of step names
  const ownersByArtifact = new Map<string, string[]>()
  for (const s of subagentSteps) {
    const relations = [
      ...(s.executionContext?.artifactRelations ?? []),
      ...(s.workflowStep?.artifactRelations ?? []),
    ]
    for (const rel of relations) {
      if (rel.relationType === "write_owner") {
        const list = ownersByArtifact.get(rel.artifactPath) ?? []
        if (!list.includes(s.name)) list.push(s.name)
        ownersByArtifact.set(rel.artifactPath, list)
      }
    }
  }

  // For each artifact with multiple owners, keep only the last and downgrade others
  for (const [artifact, owners] of ownersByArtifact) {
    if (owners.length <= 1) continue
    const downgradeSet = new Set(owners.slice(0, -1))

    for (const s of subagentSteps) {
      if (!downgradeSet.has(s.name)) continue
      const downgrade = (rels: readonly { relationType: string; artifactPath: string }[]) => {
        for (const rel of rels) {
          if (rel.artifactPath === artifact && rel.relationType === "write_owner") {
            ;(rel as { relationType: string }).relationType = "read_dependency"
          }
        }
      }
      if (s.executionContext?.artifactRelations) downgrade(s.executionContext.artifactRelations)
      if (s.workflowStep?.artifactRelations) downgrade(s.workflowStep.artifactRelations)
    }
  }
}

// ============================================================================
// Auto-fix: verification coverage
// ============================================================================

/**
 * If the plan has write steps but no verification step, upgrade the last
 * write step's verificationMode to "run_tests". This prevents the
 * no_verification_steps validation failure when the LLM omits it.
 */
function ensureVerificationCoverage(steps: PlanStep[]): void {
  const subagentSteps = steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )
  if (subagentSteps.length <= 1) return

  const hasWriters = subagentSteps.some(
    s => s.executionContext?.effectClass !== "readonly",
  )
  const hasVerification = subagentSteps.some(
    s => s.executionContext?.verificationMode !== "none",
  )

  if (hasWriters && !hasVerification) {
    // Find the last write step and upgrade its verification mode
    for (let i = subagentSteps.length - 1; i >= 0; i--) {
      const s = subagentSteps[i]
      if (s.executionContext && s.executionContext.effectClass !== "readonly") {
        // Pick verification mode based on tool capabilities
        const tools = s.requiredToolCapabilities ?? []
        const ctx = s.executionContext as { verificationMode: string }
        if (tools.includes("browser_check")) {
          ctx.verificationMode = "browser_check"
        } else if (tools.includes("run_command")) {
          ctx.verificationMode = "run_tests"
        } else {
          ctx.verificationMode = "deterministic_followup"
        }
        break
      }
    }
  }
}
