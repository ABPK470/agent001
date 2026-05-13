/**
 * Plan validation checks — path consistency, dependency wiring, visual completeness,
 * shared data contracts.
 *
 * Extracted from validate.ts for maintainability.
 *
 * @module
 */

import type { PlanDiagnostic, PlanStep, SubagentTaskStep } from "../types.js"

const RUNTIME_CODE_ARTIFACT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|wasm)$/i

export { validatePathConsistency } from "../validate/path-consistency.js"

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
