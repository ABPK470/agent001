/**
 * Workspace-root normalization and malformed-response salvage helpers.
 * Extracted from generate.ts.
 *
 * @module
 */

import { parsePlanFromResponse } from "../generate-parse.js"
import type { Plan, PlanStep, SubagentTaskStep } from "../types.js"

/**
 * Override LLM-generated workspaceRoot values in all execution contexts
 * with the actual workspace root. The LLM often gets paths wrong (uses ".",
 * relative paths, or host paths that don't match the container).
 */
export function normalizeWorkspaceRoots(plan: Plan, actualRoot: string): Plan {
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

/**
 * When the planner returns something that can't parse as a full plan,
 * try to extract any usable file-write or tool-call info and salvage it
 * into a minimal single-step plan. This prevents total failure when the
 * planner's JSON is slightly malformed or wrapped in prose.
 */
export function salvagePlanFromMalformedResponse(raw: string, _workspaceRoot: string): Plan | null {
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
