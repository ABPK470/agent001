/**
 * Plan parsing — parse LLM JSON responses into typed Plan objects, with auto-fix passes.
 *
 * Extracted from generate.ts for maintainability.
 *
 * @module
 */

import type { DeterministicToolStep, Plan, PlanDiagnostic, PlanEdge, PlanStep, SubagentTaskStep } from "./types.js"

// ============================================================================
// Plan parsing
// ============================================================================

export function parsePlanFromResponse(raw: string): {
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

  // Auto-fix passes
  normalizeArtifactDirectories(steps)
  ensureVerificationCoverage(steps)
  deduplicateWriteOwnership(steps)
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
    let writePrefix: string | null = null
    if (ctx.allowedWriteRoots?.length) {
      const wsRoot = ctx.workspaceRoot.replace(/\/$/, "")
      for (const wr of ctx.allowedWriteRoots) {
        const norm = wr.replace(/\/$/, "")
        if (norm !== wsRoot && norm !== "." && norm !== "./" && norm.startsWith(wsRoot + "/")) {
          writePrefix = norm.slice(wsRoot.length + 1)
          break
        }
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

function deduplicateWriteOwnership(steps: PlanStep[]): void {
  const subagentSteps = steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

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
// Auto-fix: strip redundant verification deterministic_tool steps
// ============================================================================

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

  for (let i = steps.length - 1; i >= 0; i--) {
    if (toRemove.has(steps[i].name)) {
      steps.splice(i, 1)
    }
  }

  for (let i = edges.length - 1; i >= 0; i--) {
    if (toRemove.has(edges[i].from) || toRemove.has(edges[i].to)) {
      edges.splice(i, 1)
    }
  }

  for (const step of steps) {
    if (step.dependsOn) {
      const filtered = step.dependsOn.filter(d => !toRemove.has(d))
      ;(step as unknown as { dependsOn: string[] }).dependsOn = filtered
    }
  }
}

// ============================================================================
// Auto-fix: verification coverage
// ============================================================================

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
    for (let i = subagentSteps.length - 1; i >= 0; i--) {
      const s = subagentSteps[i]
      if (s.executionContext && s.executionContext.effectClass !== "readonly") {
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
