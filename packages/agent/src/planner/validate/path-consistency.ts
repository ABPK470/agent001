/**
 * Path consistency validation pass. Extracted from validate-checks.ts.
 *
 * @module
 */

import type { PlanDiagnostic, PlanStep, SubagentTaskStep } from "../types.js"

export function validatePathConsistency(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  // Collect all target artifact directories
  const artifactDirs = new Map<string, string>()
  const allDirs: string[] = []

  for (const step of subagentSteps) {
    for (const artifact of step.executionContext?.targetArtifacts ?? []) {
      const parts = artifact.split("/")
      if (parts.length > 1) {
        const dir = parts.slice(0, -1).join("/")
        allDirs.push(dir)
        if (!artifactDirs.has(dir)) {
          artifactDirs.set(dir, step.name)
        }
      }
    }
  }

  if (allDirs.length === 0) return diagnostics

  // Same filename under different directories
  const filesByName = new Map<string, string[]>()
  for (const step of subagentSteps) {
    for (const artifact of step.executionContext?.targetArtifacts ?? []) {
      const filename = artifact.split("/").pop()!
      if (!filesByName.has(filename)) filesByName.set(filename, [])
      filesByName.get(filename)!.push(artifact)
    }
  }

  for (const [filename, paths] of filesByName) {
    const uniquePaths = [...new Set(paths)]
    if (uniquePaths.length > 1) {
      const dirs = uniquePaths.map(p => p.split("/").slice(0, -1).join("/") || "(root)")
      diagnostics.push({
        category: "graph",
        severity: "error",
        code: "inconsistent_output_directory",
        message: `File "${filename}" appears under different directories: ${dirs.join(", ")}. All steps MUST use the same output directory. Pick one directory and use it consistently for ALL targetArtifacts across all steps.`,
      })
    }
  }

  // Mixed root + subdir
  const hasDir = allDirs.length > 0
  const rootFiles = subagentSteps.flatMap(s =>
    (s.executionContext?.targetArtifacts ?? []).filter(a => !a.includes("/"))
  )
  if (hasDir && rootFiles.length > 0) {
    const commonDir = allDirs[0]
    diagnostics.push({
      category: "graph",
      severity: "error",
      code: "mixed_root_and_subdir",
      message: `Some artifacts are in subdirectory "${commonDir}/" but others (${rootFiles.join(", ")}) are at the root. Move all artifacts into the same directory.`,
    })
  }

  // Inconsistent root output tree
  const uniqueRootDirs = new Set(
    allDirs.map((d) => {
      const root = d.split("/")[0]
      return root && root.length > 0 ? root : "(root)"
    }),
  )
  if (uniqueRootDirs.size > 1) {
    diagnostics.push({
      category: "graph",
      severity: "error",
      code: "inconsistent_output_directory",
      message: `Steps use ${uniqueRootDirs.size} different root output directories: ${[...uniqueRootDirs].join(", ")}. ` +
        `ALL steps MUST write to the SAME directory tree. Pick one and use it for all targetArtifacts.`,
    })
  }

  // Divergent project namespaces under shared root
  const FUNCTIONAL_SUBDIRS = new Set([
    "src", "lib", "app", "apps", "public", "assets", "static", "styles", "style", "css", "js", "scripts", "img", "images", "fonts", "tests", "test",
  ])
  const extractNamespace = (dir: string): string => {
    const parts = dir.split("/").filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i]!.toLowerCase()
      if (FUNCTIONAL_SUBDIRS.has(seg)) continue
      return parts[i]!
    }
    return ""
  }
  const namespaces = new Set(
    allDirs
      .map((d) => extractNamespace(d))
      .filter((n) => n.length > 0),
  )
  if (uniqueRootDirs.size === 1 && namespaces.size > 1) {
    diagnostics.push({
      category: "graph",
      severity: "error",
      code: "inconsistent_output_directory",
      message: `Steps diverge into different project namespaces under one root: ${[...namespaces].join(", ")}. ` +
        `ALL steps must write to one coherent project tree (same namespace) to avoid broken cross-file wiring.`,
    })
  }

  // Multiple steps targeting same artifact (full-file rewrite collisions)
  const targetWriters = new Map<string, string[]>()
  for (const step of subagentSteps) {
    for (const artifact of step.executionContext?.targetArtifacts ?? []) {
      const writers = targetWriters.get(artifact) ?? []
      writers.push(step.name)
      targetWriters.set(artifact, writers)
    }
  }
  for (const [artifact, writers] of targetWriters) {
    if (writers.length > 1) {
      diagnostics.push({
        category: "ownership",
        severity: "error",
        code: "shared_target_artifact",
        message: `File "${artifact}" is a targetArtifact of ${writers.length} steps: [${writers.join(", ")}]. ` +
          `Each step does a full file rewrite, so later steps will overwrite earlier steps' changes. ` +
          `COMBINE these steps into a single step, or ensure only one step writes to this file.`,
      })
    }
  }

  return diagnostics
}
