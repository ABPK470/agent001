/**
 * Plan normalization — warning injection, output directory normalization,
 * shared contract injection, dependency wiring, step merging, and remediation.
 *
 * Extracted from planner/index.ts for maintainability.
 *
 * @module
 */

import type { Plan, PlanDiagnostic, SubagentTaskStep } from "../types.js"

// ============================================================================
// Warning injection
// ============================================================================

export function injectWarningsIntoSteps(plan: Plan, warnings: readonly PlanDiagnostic[]): void {
  const stepWarnings = new Map<string, string[]>()
  const globalWarnings: string[] = []

  for (const w of warnings) {
    if (w.stepName) {
      const arr = stepWarnings.get(w.stepName) ?? []
      arr.push(w.message)
      stepWarnings.set(w.stepName, arr)
    } else {
      globalWarnings.push(w.message)
    }
  }

  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const msgs = [...(stepWarnings.get(sa.name) ?? []), ...globalWarnings]
    if (msgs.length === 0) continue
    const suffix = `\n\n⚠️ VALIDATION WARNINGS (address these in your implementation):\n${msgs.map((m) => `- ${m}`).join("\n")}`
    ;(sa as { objective: string }).objective = sa.objective + suffix
  }
}

export function applyWarningAutoFixes(plan: Plan, warnings: readonly PlanDiagnostic[]): void {
  const codes = new Set(warnings.map((w) => w.code))

  if (codes.has("inconsistent_output_directory") || codes.has("mixed_root_and_subdir")) {
    normalizePlanOutputDirectory(plan)
  }

  if (codes.has("missing_shared_data_contract")) {
    injectSharedDataContract(plan)
  }

  if (codes.has("missing_dependency_wiring_criteria")) {
    injectDependencyWiringCriteria(plan)
  }

  injectBrowserRuntimeContracts(plan)
  injectHelperDependencyContracts(plan)
  injectVisualStyleContracts(plan)
}

// ============================================================================
// Output directory normalization
// ============================================================================

function normalizeOutputDirToken(raw: string): string {
  return raw
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/+$/, "")
}

export function inferForcedOutputDirectoryFromGoal(goal: string): string | null {
  const namedMatch = goal.match(/\btemporary\s+working\s+directory\s+named\s+([a-zA-Z0-9._\/-]+)/i)
  if (namedMatch?.[1]) {
    const dir = normalizeOutputDirToken(namedMatch[1])
    if (dir && !dir.includes("..")) return dir
  }

  const constrainedPathMatch = goal.match(
    /\ball\s+project\s+files\b[\s\S]{0,120}?\b(?:in|under|inside)\s+([a-zA-Z0-9._\/-]+)/i
  )
  if (constrainedPathMatch?.[1]) {
    const dir = normalizeOutputDirToken(constrainedPathMatch[1])
    if (dir && !dir.includes("..")) return dir
  }

  if (/\ball\s+project\s+files\b[\s\S]{0,120}?\btmp\b/i.test(goal)) {
    return "tmp"
  }

  return null
}

export function normalizePlanOutputDirectory(plan: Plan, preferredDirOverride?: string): void {
  const subagentSteps = plan.steps.filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")
  const dirs: string[] = []

  for (const step of subagentSteps) {
    for (const artifact of step.executionContext.targetArtifacts) {
      const normalized = artifact.replace(/^\.\//, "")
      const slash = normalized.lastIndexOf("/")
      if (slash > 0) dirs.push(normalized.slice(0, slash))
    }
  }

  const preferredDir = normalizeOutputDirToken(preferredDirOverride ?? "") || (mostFrequent(dirs) ?? "tmp")
  const knownTopDirs = new Set(dirs.map((d) => d.split("/")[0]).filter(Boolean))
  const targetByBasename = new Map<string, string>()

  for (const step of subagentSteps) {
    const current = step.executionContext.targetArtifacts
    const normalized = current.map((artifact) => {
      const path = artifact.replace(/^\.\//, "")
      if (!path.includes("/")) return `${preferredDir}/${path}`
      if (path.startsWith(`${preferredDir}/`)) return path
      const parts = path.split("/")
      return `${preferredDir}/${parts.slice(1).join("/")}`
    })
    ;(step.executionContext as unknown as { targetArtifacts: readonly string[] }).targetArtifacts = normalized

    const wsRoot = step.executionContext.workspaceRoot.replace(/\/+$/, "")
    const scopedWriteRoot =
      wsRoot && (wsRoot.startsWith("/") || /^[A-Za-z]:[\\/]/.test(wsRoot))
        ? `${wsRoot}/${preferredDir}`
        : preferredDir
    ;(step.executionContext as unknown as { allowedWriteRoots: readonly string[] }).allowedWriteRoots = [
      scopedWriteRoot
    ]

    for (const target of normalized) {
      const base = target.split("/").pop()
      if (!base) continue
      if (!targetByBasename.has(base)) {
        targetByBasename.set(base, target)
      }
    }
  }

  for (const step of subagentSteps) {
    const currentSources = step.executionContext.requiredSourceArtifacts
    const normalizedSources = currentSources.map((artifact) => {
      const source = artifact.replace(/^\.\//, "")
      if (source.startsWith(`${preferredDir}/`)) return source

      const slash = source.indexOf("/")
      if (slash > 0) {
        const top = source.slice(0, slash)
        if (knownTopDirs.has(top)) {
          return `${preferredDir}/${source.slice(slash + 1)}`
        }
      }

      const base = source.split("/").pop() ?? source
      return targetByBasename.get(base) ?? source
    })
    ;(
      step.executionContext as unknown as { requiredSourceArtifacts: readonly string[] }
    ).requiredSourceArtifacts = [...new Set(normalizedSources)]
  }
}

// ============================================================================
// Contract injection — extracted to ./contract-injection.ts
// ============================================================================

import {
  injectBrowserRuntimeContracts,
  injectDependencyWiringCriteria,
  injectHelperDependencyContracts,
  injectSharedDataContract,
  injectVisualStyleContracts
} from "./contract-injection.js"

export {
  injectBrowserRuntimeContracts,
  injectDependencyWiringCriteria,
  injectHelperDependencyContracts,
  injectSharedDataContract,
  injectSharedStateOwnershipContract,
  injectVisualStyleContracts
} from "./contract-injection.js"

export function uniqueList(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export function mostFrequent(items: readonly string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  let best: string | undefined
  let bestCount = -1
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item
      bestCount = count
    }
  }
  return best
}

// Re-export remediation helpers for backwards compatibility
export { inferOutputDir, remediateValidationErrors } from "../internal/index-remediate.js"
