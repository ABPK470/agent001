/**
 * Plan parsing — parse LLM JSON responses into typed Plan objects, with auto-fix passes.
 *
 * Extracted from generate.ts for maintainability.
 *
 * @module
 */

import type { DeterministicToolStep, Plan, PlanDiagnostic, PlanEdge, PlanStep, SubagentTaskStep } from "../types.js"
import {
    deduplicateWriteOwnership,
    ensureVerificationCoverage,
    isValidArtifactPath,
    normalizeArtifactDirectories,
    parseArtifactRelations,
    parseEffectClass,
    parseStepRole,
    parseVerificationMode,
    safeStringArray,
    stripRedundantVerificationSteps,
} from "./helpers.js"

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
