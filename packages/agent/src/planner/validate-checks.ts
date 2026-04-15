/**
 * Plan validation checks — path consistency, dependency wiring, visual completeness,
 * shared data contracts.
 *
 * Extracted from validate.ts for maintainability.
 *
 * @module
 */

import type { PlanDiagnostic, PlanStep, SubagentTaskStep } from "./types.js"

const RUNTIME_CODE_ARTIFACT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|wasm)$/i

// ============================================================================
// Path consistency — all steps must use the same output directory
// ============================================================================

export function validatePathConsistency(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  // Collect all target artifact directories
  const artifactDirs = new Map<string, string>() // dir → step name (first seen)
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

  // Check if the same filename appears under different directories
  // e.g. "game/index.html" and "tmp/game/index.html" — this is a clear error
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
      // Same filename in different directories — likely a path inconsistency
      const dirs = uniquePaths.map(p => p.split("/").slice(0, -1).join("/") || "(root)")
      diagnostics.push({
        category: "graph",
        severity: "error",
        code: "inconsistent_output_directory",
        message: `File "${filename}" appears under different directories: ${dirs.join(", ")}. All steps MUST use the same output directory. Pick one directory and use it consistently for ALL targetArtifacts across all steps.`,
      })
    }
  }

  // Also check: if some artifacts have a directory prefix and others don't
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

  // Check for inconsistent root output tree across steps.
  // Sibling subdirectories under the same root (tmp/css, tmp/js) are valid and
  // should NOT fail path consistency validation.
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

  // Under a shared root (e.g. tmp/*), detect divergent project namespaces.
  // Example of invalid split tree: tmp/project_alpha/* vs tmp/project_beta/*.
  // Example of valid sibling functional dirs: tmp/css/* and tmp/js/*.
  const FUNCTIONAL_SUBDIRS = new Set([
    "src", "lib", "app", "apps", "public", "assets", "static", "styles", "style", "css", "js", "scripts", "img", "images", "fonts", "tests", "test",
  ])
  const extractNamespace = (dir: string): string => {
    const parts = dir.split("/").filter(Boolean)
    // Skip root prefix (parts[0]); namespace starts from the next non-functional segment.
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

  // Check for multiple steps writing the same file (not just write_owner
  // declarations, but actual targetArtifacts overlap).  This catches the
  // common "children stomp on each other" failure pattern where step A
  // fixes something in a file and step B rewrites the entire file for a
  // different fix, losing step A's changes.
  const targetWriters = new Map<string, string[]>() // artifact → step names
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

// ============================================================================
// Artifact dependency wiring validation
// ============================================================================

/**
 * When a step owns both consumer artifacts (entry/markup files) and producer
 * artifacts (runtime/dependency files), ensure its objective/criteria mention
 * dependency wiring/integration behavior.
 */
export function validateArtifactDependencyWiring(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  const allConsumer: string[] = []
  const allProducer: string[] = []

  for (const sa of subagentSteps) {
    for (const artifact of sa.executionContext?.targetArtifacts ?? []) {
      if (/\.(?:html?|xhtml|xml|md|markdown|svg)$/i.test(artifact)) allConsumer.push(artifact)
      else if (RUNTIME_CODE_ARTIFACT_RE.test(artifact)) allProducer.push(artifact)
    }
  }

  if (allConsumer.length === 0 || allProducer.length === 0) return diagnostics

  for (const consumerArtifact of allConsumer) {
    const ownerStep = subagentSteps.find(
      sa => sa.executionContext?.targetArtifacts?.includes(consumerArtifact),
    )
    if (!ownerStep) continue

    const ownProducer = (ownerStep.executionContext?.targetArtifacts ?? []).filter(a => RUNTIME_CODE_ARTIFACT_RE.test(a))
    if (ownProducer.length === 0) continue

    const combined = [
      ownerStep.objective,
      ...ownerStep.acceptanceCriteria,
    ].join(" ").toLowerCase()

    const wiringCue = /\b(?:load|import|include|link|reference|wire|attach|depends?\s+on|hook(?:s|ed)?\s+up)\b/i.test(combined)
    const mentionsProducer = ownProducer.some((a) => {
      const base = a.split("/").pop() ?? a
      return combined.includes(base.toLowerCase())
    })

    if (!wiringCue && !mentionsProducer) {
      diagnostics.push({
        category: "contract",
        severity: "warning",
        code: "missing_dependency_wiring_criteria",
        message: `Step "${ownerStep.name}" creates consumer artifact "${consumerArtifact}" and also owns dependency artifacts (${ownProducer.map(a => a.split("/").pop()).join(", ")}), but its objective/criteria don't mention dependency wiring/integration. ` +
          `Add explicit criteria describing how produced artifacts are linked or consumed together.`,
        stepName: ownerStep.name,
      })
    }
  }

  return diagnostics
}

// ============================================================================
// Visual completeness — UI tasks must have display/render criteria
// ============================================================================

/** Keywords that indicate a task involves visual/UI output. */
const VISUAL_TASK_RE =
  /\b(?:visual|render|displa|animat|canvas|sprite|ui|interface|dashboard|chart|graph|diagram|widget|layout|screen|view)\b/i

/** Keywords that indicate a step covers visual content rendering. */
const VISUAL_CONTENT_RE =
  /\b(?:render|display|show|draw|paint|place|position|symbol|sprite|image|icon|unicode|piece|tile|cell|marker|token|avatar|visual|appear|visible)s?\b/i

/**
 * When a plan's reason or step objectives indicate a visual/UI task,
 * ensure that at least one step's acceptance criteria explicitly covers
 * rendering visual content (not just creating a grid/layout).
 *
 * This catches the "layout exists but meaningful content is not rendered" pattern.
 */
export function validateVisualCompleteness(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]
  if (subagentSteps.length === 0) return diagnostics

  // Check if this is a visual/UI task
  const allObjectives = subagentSteps.map(sa => sa.objective).join(" ")
  const isVisualTask = VISUAL_TASK_RE.test(allObjectives)
  if (!isVisualTask) return diagnostics

  // Check that at least one step's acceptance criteria mentions visual content rendering
  const hasVisualCriteria = subagentSteps.some(sa =>
    sa.acceptanceCriteria.some(c => VISUAL_CONTENT_RE.test(c)),
  )

  if (!hasVisualCriteria) {
    diagnostics.push({
      category: "contract",
      severity: "warning",
      code: "missing_visual_rendering_criteria",
      message: `This appears to be a visual/UI task but NO step has acceptance criteria for rendering visual content. ` +
        `Add specific criteria like "pieces display correct Unicode symbols", "tiles show their values", or "chart renders data points". ` +
        `Without visual rendering criteria, the output will have structure (grid/layout) but no visible content.`,
    })
  }

  return diagnostics
}

// ============================================================================
// Shared data contract validation — multi-file JS projects
// ============================================================================

/** Pattern for data-format keywords that signal shared state. */
const DATA_FORMAT_RE =
  /\b(?:state|schema|model|record|entity|items?|nodes?|entries|rows?|columns?|map|dictionary|payload)\b/i

/**
 * When a plan has 2+ JS files written by different steps, verify that at
 * least one step's objective specifies the shared data format. Without this,
 * each child invents its own data structure and the files are incompatible.
 */
export function validateSharedDataContract(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  // Collect steps that write JS files
  const jsWriterSteps = subagentSteps.filter(sa =>
    (sa.executionContext?.targetArtifacts ?? []).some(a => /\.js$/i.test(a)),
  )

  // Only relevant when 2+ different steps produce JS files
  if (jsWriterSteps.length < 2) return diagnostics

  // Check if the task involves shared data structures
  const allObjectives = jsWriterSteps.map(sa => sa.objective).join(" ")
  if (!DATA_FORMAT_RE.test(allObjectives)) return diagnostics

  // Check that at least one step defines the data format in its objective
  const FORMAT_SPEC_RE = /\b(?:format|structure|schema|interface|shape|object\s*\{|array\s*of|record\s*of|map\s*of|canonical\s+data\s+contract)\b/i
  const hasFormatSpec = jsWriterSteps.some(sa => FORMAT_SPEC_RE.test(sa.objective))

  if (!hasFormatSpec) {
    diagnostics.push({
      category: "contract",
      severity: "warning",
      code: "missing_shared_data_contract",
      message: `Plan has ${jsWriterSteps.length} steps writing JS files that reference shared data (${
        allObjectives.match(DATA_FORMAT_RE)?.[0] ?? "state"
      }) but NO step's objective defines the data format. ` +
        `Add a specific data structure definition to the first JS step's objective, e.g. ` +
        `"Records use { id: string, status: string } and state is a keyed map by id." ` +
        `Without this, each child will invent its own incompatible format.`,
    })
  }

  return diagnostics
}
