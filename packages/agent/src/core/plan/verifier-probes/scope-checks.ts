/**
 * Path mismatch + off-target write detection used during subagent assessment.
 *
 * @module
 */

import type { Plan, SubagentTaskStep } from "../types.js"

export function detectPathMismatchIssues(
  probeCache: ReadonlyMap<string, { found: boolean; resolvedPath: string }>,
  wsRoot: string | undefined
): string[] {
  const issues: string[] = []
  for (const [artifact, probe] of probeCache) {
    if (!probe.found) continue
    const normPlanned = artifact.replace(/^\.\//, "")
    const normResolved = probe.resolvedPath.replace(/^\.\//, "")
    if (normResolved === normPlanned) continue
    const stripped = wsRoot
      ? normResolved.replace(new RegExp(`^${wsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "")
      : normResolved
    if (stripped !== normPlanned) {
      issues.push(
        `PATH MISMATCH: artifact "${artifact}" was found at "${probe.resolvedPath}" instead of the planned path. ` +
          `The child wrote to the WRONG directory. HTML and other files reference the planned path, so this file will NOT be loaded. ` +
          `The child must write to the EXACT path specified in targetArtifacts.`
      )
    }
  }
  return issues
}

export function detectScopeViolationIssues(
  step: SubagentTaskStep,
  plan: Plan,
  outputText: string,
  wsRoot: string | undefined
): string[] {
  const issues: string[] = []
  const targetSet = new Set(step.executionContext.targetArtifacts.map((a) => a.replace(/^\.\//, "")))
  const allowedIntegrationWriteSet = new Set(
    step.executionContext.requiredSourceArtifacts.map((a) => a.replace(/^\.\//, ""))
  )
  const writtenPathsForScopeCheck = new Set<string>()
  for (const m of outputText.matchAll(
    /(?:creat|writ|wrote|modif|generat|saved)\w*\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi
  )) {
    if (m[1] && m[1].length < 200) writtenPathsForScopeCheck.add(m[1])
  }
  for (const actual of writtenPathsForScopeCheck) {
    const normActual = actual.replace(/^\.\//, "")
    const stripped = wsRoot
      ? normActual.replace(new RegExp(`^${wsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "")
      : normActual
    if (allowedIntegrationWriteSet.has(stripped) || allowedIntegrationWriteSet.has(normActual)) continue
    if (!targetSet.has(stripped) && !targetSet.has(normActual)) {
      const ownedByOtherStep = plan.steps.some((s) => {
        if (s.name === step.name || s.stepType !== "subagent_task") return false
        const other = s as SubagentTaskStep
        return other.executionContext.targetArtifacts.some(
          (a) => a.replace(/^\.\//, "") === stripped || a.replace(/^\.\//, "") === normActual
        )
      })
      if (ownedByOtherStep) {
        issues.push(
          `SCOPE VIOLATION: Child wrote to "${actual}" which belongs to a DIFFERENT step's targetArtifacts. ` +
            `Each step must ONLY write to its own target files. Writing to other steps' files causes overwrites and data loss.`
        )
      }
    }
  }
  return issues
}
