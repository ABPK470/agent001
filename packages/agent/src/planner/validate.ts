/**
 * Plan validation — multi-pass structural and semantic checks on a generated plan.
 *
 * Validates:
 *   1. Parse integrity — all required fields present, types correct
 *   2. Graph validity — no cycles, reasonable depth/fanout
 *   3. Step contracts — subagent tasks have proper acceptance criteria, tool steps reference real tools
 *   4. Artifact ownership — at most one write_owner per artifact
 *   5. Verification requirements — implementors have verification steps
 *
 * Returns diagnostics with refinement hints the planner can use to fix the plan.
 *
 * @module
 */

import type { Tool } from "../types.js"
import type { DeterministicToolStep, Plan, PlanDiagnostic, PlanEdge, PlanStep, SubagentTaskStep } from "./types.js"

const RUNTIME_CODE_ARTIFACT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|wasm)$/i

// ============================================================================
// Main validation entry point
// ============================================================================

export interface ValidationResult {
  readonly valid: boolean
  readonly diagnostics: readonly PlanDiagnostic[]
}

/**
 * Run all validation passes on a plan.
 *
 * @param plan - The parsed plan to validate
 * @param availableTools - Available tools (for checking tool references)
 */
export function validatePlan(
  plan: Plan,
  availableTools: readonly Tool[],
): ValidationResult {
  const diagnostics: PlanDiagnostic[] = []

  diagnostics.push(...validateGraph(plan.steps, plan.edges))
  diagnostics.push(...validateToolReferences(plan.steps, availableTools))
  diagnostics.push(...validateStepContracts(plan.steps))
  diagnostics.push(...validateArtifactOwnership(plan.steps))
  diagnostics.push(...validateVerificationCoverage(plan.steps))
  diagnostics.push(...validatePathConsistency(plan.steps))
  diagnostics.push(...validateArtifactDependencyWiring(plan.steps))
  diagnostics.push(...validatePrematureBrowserVerification(plan.steps))
  diagnostics.push(...validateVisualCompleteness(plan.steps))
  diagnostics.push(...validateSharedDataContract(plan.steps))

  return {
    valid: diagnostics.filter(d => d.severity === "error").length === 0,
    diagnostics,
  }
}

function artifactDir(path: string): string {
  const parts = path.split("/")
  if (parts.length <= 1) return ""
  return parts.slice(0, -1).join("/")
}

function isSameOrNestedDir(candidate: string, base: string): boolean {
  if (!base) return candidate.length === 0
  return candidate === base || candidate.startsWith(`${base}/`)
}

// ============================================================================
// Browser verification ordering
// ============================================================================

/**
 * Detect impossible contracts where a browser_check step runs on web entry
 * artifacts before related web runtime artifacts are produced by other steps.
 */
function validatePrematureBrowserVerification(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  const runtimeByStep = new Map<string, string[]>()
  for (const step of subagentSteps) {
    const runtimeArtifacts = (step.executionContext?.targetArtifacts ?? [])
      .filter(a => RUNTIME_CODE_ARTIFACT_RE.test(a))
    runtimeByStep.set(step.name, runtimeArtifacts)
  }

  for (const step of subagentSteps) {
    if (step.executionContext?.verificationMode !== "browser_check") continue
    const entryTargets = (step.executionContext?.targetArtifacts ?? []).filter(a => /\.(?:html?|xhtml)$/i.test(a))
    if (entryTargets.length === 0) continue

    const ownRuntime = new Set(runtimeByStep.get(step.name) ?? [])
    const entryDirs = entryTargets.map(artifactDir)

    const ownRuntimeDirs = new Set([...ownRuntime].map(artifactDir))
    const relatedForeignRuntime = subagentSteps
      .filter(s => s.name !== step.name)
      .flatMap(s => runtimeByStep.get(s.name) ?? [])
      .filter((artifactPath) => {
        if (ownRuntime.has(artifactPath)) return false
        const runtimeDir = artifactDir(artifactPath)
        if (ownRuntimeDirs.size > 0) {
          return ownRuntimeDirs.has(runtimeDir)
        }
        return entryDirs.some((dir) => isSameOrNestedDir(runtimeDir, dir) || isSameOrNestedDir(dir, runtimeDir))
      })

    if (relatedForeignRuntime.length > 0) {
      const sample = [...new Set(relatedForeignRuntime)].slice(0, 4).join(", ")
      diagnostics.push({
        category: "verification",
        severity: "error",
        code: "premature_browser_verification",
        message: `Step "${step.name}" runs browser_check on web entry artifacts before related runtime artifacts are owned by this step: ${sample}. ` +
          `Move required runtime artifacts into this step, or defer browser_check to a later integration owner step that includes all referenced assets.`,
        stepName: step.name,
      })
    }
  }

  return diagnostics
}

// ============================================================================
// Graph validation — cycles, fanout, depth
// ============================================================================

function validateGraph(steps: readonly PlanStep[], edges: readonly PlanEdge[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const stepNames = new Set(steps.map(s => s.name))

  // Build adjacency
  const adj = new Map<string, string[]>()
  for (const name of stepNames) adj.set(name, [])
  for (const e of edges) {
    adj.get(e.from)?.push(e.to)
  }

  // Cycle detection via DFS coloring
  const WHITE = 0, GREY = 1, BLACK = 2
  const color = new Map<string, number>()
  for (const name of stepNames) color.set(name, WHITE)

  function dfs(node: string): boolean {
    color.set(node, GREY)
    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GREY) return true // back edge = cycle
      if (color.get(neighbor) === WHITE && dfs(neighbor)) return true
    }
    color.set(node, BLACK)
    return false
  }

  for (const name of stepNames) {
    if (color.get(name) === WHITE && dfs(name)) {
      diagnostics.push({
        category: "graph",
        severity: "error",
        code: "cycle_detected",
        message: "Plan dependency graph contains a cycle. Remove circular dependencies between steps.",
        stepName: name,
      })
      break // one cycle error is enough
    }
  }

  // Fanout — max outgoing edges from any node
  for (const [name, neighbors] of adj) {
    if (neighbors.length > 8) {
      diagnostics.push({
        category: "graph",
        severity: "warning",
        code: "excessive_fanout",
        message: `Step "${name}" has ${neighbors.length} outgoing edges. Reduce fanout to <=8 to keep the plan manageable.`,
        stepName: name,
      })
    }
  }

  // Depth — longest path through the graph
  if (diagnostics.length === 0) { // skip if cycles exist
    const depth = longestPath(stepNames, adj)
    if (depth > 10) {
      diagnostics.push({
        category: "graph",
        severity: "warning",
        code: "excessive_depth",
        message: `Plan has critical path depth ${depth}. Reduce to <=10 by parallelizing independent work.`,
      })
    }
  }

  // Step count warning
  if (steps.length > 15) {
    diagnostics.push({
      category: "graph",
      code: "too_many_steps",
      severity: "warning",
      message: `Plan has ${steps.length} steps. Prefer 2-8 steps. Consolidate related work into fewer subagent tasks.`,
    })
  }

  return diagnostics
}

function longestPath(nodes: Set<string>, adj: Map<string, string[]>): number {
  const memo = new Map<string, number>()

  function dp(node: string): number {
    if (memo.has(node)) return memo.get(node)!
    let maxChild = 0
    for (const n of adj.get(node) ?? []) {
      maxChild = Math.max(maxChild, dp(n))
    }
    const result = 1 + maxChild
    memo.set(node, result)
    return result
  }

  let max = 0
  for (const n of nodes) max = Math.max(max, dp(n))
  return max
}

// ============================================================================
// Tool reference validation
// ============================================================================

function validateToolReferences(
  steps: readonly PlanStep[],
  availableTools: readonly Tool[],
): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const toolNames = new Set(availableTools.map(t => t.name))

  for (const step of steps) {
    if (step.stepType === "deterministic_tool") {
      const dt = step as DeterministicToolStep
      if (!toolNames.has(dt.tool)) {
        diagnostics.push({
          category: "contract",
          severity: "error",
          code: "unknown_tool",
          message: `Deterministic step "${step.name}" references tool "${dt.tool}" which is not available. Available tools: ${[...toolNames].join(", ")}`,
          stepName: step.name,
        })
      }
    }
  }

  return diagnostics
}

// ============================================================================
// Step contract validation
// ============================================================================

function validateStepContracts(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  for (const step of steps) {
    if (step.stepType === "subagent_task") {
      const sa = step as SubagentTaskStep

      if (!sa.objective || sa.objective.trim().length < 10) {
        diagnostics.push({
          category: "contract",
          severity: "warning",
          code: "vague_objective",
          message: `Subagent step "${step.name}" has a vague or missing objective. Provide a specific, measurable objective (min 10 chars).`,
          stepName: step.name,
        })
      }

      if (sa.acceptanceCriteria.length === 0) {
        diagnostics.push({
          category: "contract",
          severity: "warning",
          code: "missing_acceptance_criteria",
          message: `Subagent step "${step.name}" has no acceptance criteria. Add at least one measurable success condition.`,
          stepName: step.name,
        })
      }

      // Check for vague criteria
      for (const crit of sa.acceptanceCriteria) {
        if (crit.length < 10 || /^(done|works?|good|complete|ok)$/i.test(crit.trim())) {
          diagnostics.push({
            category: "contract",
            severity: "warning",
            code: "vague_criteria",
            message: `Subagent step "${step.name}" has vague acceptance criterion: "${crit}". Be specific and measurable.`,
            stepName: step.name,
          })
        }
      }

      if (sa.requiredToolCapabilities.length === 0) {
        diagnostics.push({
          category: "contract",
          severity: "warning",
          code: "no_tool_capabilities",
          message: `Subagent step "${step.name}" declares no required tool capabilities. Specify which tools the child needs.`,
          stepName: step.name,
        })
      }
    }
  }

  return diagnostics
}

// ============================================================================
// Artifact ownership validation
// ============================================================================

function validateArtifactOwnership(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  // Collect write_owner claims per artifact
  const writeOwners = new Map<string, string[]>()

  for (const step of steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const relations = [
      ...(sa.executionContext?.artifactRelations ?? []),
      ...(sa.workflowStep?.artifactRelations ?? []),
    ]
    for (const rel of relations) {
      if (rel.relationType === "write_owner") {
        const owners = writeOwners.get(rel.artifactPath) ?? []
        if (!owners.includes(step.name)) {
          owners.push(step.name)
        }
        writeOwners.set(rel.artifactPath, owners)
      }
    }
  }

  for (const [artifact, owners] of writeOwners) {
    if (owners.length > 1) {
      diagnostics.push({
        category: "ownership",
        severity: "error",
        code: "multiple_write_owners",
        message: `Artifact "${artifact}" has ${owners.length} write owners: [${owners.join(", ")}]. Only ONE step may be write_owner for a given artifact.`,
      })
    }
  }

  return diagnostics
}

// ============================================================================
// Verification coverage
// ============================================================================

function validateVerificationCoverage(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  // If there are write steps but no step with verification mode set, emit
  // guidance only. Runtime/test verification can still run in the final
  // verifier after implementation is complete.
  const hasWriters = subagentSteps.some(
    s => s.executionContext?.effectClass !== "readonly",
  )
  const hasVerification = subagentSteps.some(
    s => s.executionContext?.verificationMode !== "none",
  )

  if (hasWriters && !hasVerification && subagentSteps.length > 1) {
    diagnostics.push({
      category: "verification",
      severity: "warning",
      code: "no_verification_steps",
      message: "Plan has write steps but no per-step verification mode. This is allowed; final verifier checks run after implementation. Consider setting verificationMode only on steps that fully own runnable artifacts.",
    })
  }

  return diagnostics
}

// ============================================================================
// Path consistency — all steps must use the same output directory
// ============================================================================

function validatePathConsistency(steps: readonly PlanStep[]): PlanDiagnostic[] {
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
function validateArtifactDependencyWiring(steps: readonly PlanStep[]): PlanDiagnostic[] {
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
function validateVisualCompleteness(steps: readonly PlanStep[]): PlanDiagnostic[] {
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
function validateSharedDataContract(steps: readonly PlanStep[]): PlanDiagnostic[] {
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
