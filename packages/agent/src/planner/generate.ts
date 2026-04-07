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
    "Measurable success condition 1",
    "Measurable success condition 2"
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
6. For web projects: include verification steps (browser_check, test runs)
7. workspaceRoot should match the actual working directory
8. DO NOT produce plans with only read/analysis steps — if the task asks to BUILD something, include write steps
9. Each step name must be unique across the plan
10. VERIFICATION REQUIRED: If ANY step writes files (effectClass != "readonly"), at least ONE subagent_task step MUST have verificationMode set to "browser_check", "run_tests", or "deterministic_followup" — never leave ALL steps with verificationMode: "none" when there are writes
11. A step that writes >200 lines of logic is TOO BIG. Break it down further. Each step's targetArtifacts should be either a single complex file or 2-3 simple files, not more.

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
          category: "parse",
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
        diagnostics.push(...parsed.diagnostics)
        refinementHint = parsed.diagnostics.map(d => d.message).join("\n")
        continue
      }

      return { plan: parsed.plan, diagnostics, rawResponse }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      diagnostics.push({
        category: "parse",
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
      category: "parse",
      code: "invalid_json",
      message: "Response is not valid JSON. Respond with ONLY a JSON object, no markdown.",
    })
    return { plan: null, diagnostics }
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    diagnostics.push({
      category: "parse",
      code: "not_object",
      message: "Response must be a JSON object with { reason, steps, edges }.",
    })
    return { plan: null, diagnostics }
  }

  const data = obj as Record<string, unknown>

  // Validate required fields
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    diagnostics.push({
      category: "parse",
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
        category: "parse",
        code: "invalid_step",
        message: `Step ${i} is not an object.`,
      })
      return { plan: null, diagnostics }
    }

    const name = String(raw.name ?? `step_${i}`)
    if (stepNames.has(name)) {
      diagnostics.push({
        category: "graph",
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
        category: "parse",
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
          category: "graph",
          code: "edge_unknown_source",
          message: `Edge from "${from}" → "${to}": source step "${from}" not found.`,
        })
        continue
      }
      if (!stepNames.has(to)) {
        diagnostics.push({
          category: "graph",
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
            category: "graph",
            code: "dependency_not_found",
            message: `Step "${step.name}" depends on "${dep}", which doesn't exist.`,
          })
        } else if (!edges.some(e => e.from === dep && e.to === step.name)) {
          edges.push({ from: dep, to: step.name })
        }
      }
    }
  }

  // Auto-fix: ensure verification coverage on write plans
  ensureVerificationCoverage(steps)

  // Auto-fix: deduplicate write ownership per artifact
  deduplicateWriteOwnership(steps)

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
      category: "contract",
      code: "missing_objective",
      message: `Subagent step "${name}" must have a string 'objective'.`,
    })
    return { step: null, diagnostics }
  }

  const acceptanceCriteria = safeStringArray(raw.acceptanceCriteria)
  if (acceptanceCriteria.length === 0) {
    diagnostics.push({
      category: "contract",
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
    targetArtifacts: safeStringArray(execCtx.targetArtifacts),
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
// Auto-fix: deduplicate write ownership
// ============================================================================

/**
 * If multiple steps claim write_owner on the same artifact, keep only the
 * last one in step order (the downstream implementor) and downgrade earlier
 * ones to read_dependency. This prevents the multiple_write_owners
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
