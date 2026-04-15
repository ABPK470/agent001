/**
 * Plan normalization — warning injection, output directory normalization,
 * shared contract injection, dependency wiring, step merging, and remediation.
 *
 * Extracted from planner/index.ts for maintainability.
 *
 * @module
 */

import type {
    Plan,
    PlanDiagnostic,
    SubagentTaskStep
} from "./types.js"

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
    const msgs = [
      ...(stepWarnings.get(sa.name) ?? []),
      ...globalWarnings,
    ]
    if (msgs.length === 0) continue
    const suffix = `\n\n⚠️ VALIDATION WARNINGS (address these in your implementation):\n${msgs.map(m => `- ${m}`).join("\n")}`
    ;(sa as { objective: string }).objective = sa.objective + suffix
  }
}

export function applyWarningAutoFixes(plan: Plan, warnings: readonly PlanDiagnostic[]): void {
  const codes = new Set(warnings.map(w => w.code))

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
    /\ball\s+project\s+files\b[\s\S]{0,120}?\b(?:in|under|inside)\s+([a-zA-Z0-9._\/-]+)/i,
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
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )
  const dirs: string[] = []

  for (const step of subagentSteps) {
    for (const artifact of step.executionContext.targetArtifacts) {
      const normalized = artifact.replace(/^\.\//, "")
      const slash = normalized.lastIndexOf("/")
      if (slash > 0) dirs.push(normalized.slice(0, slash))
    }
  }

  const preferredDir = normalizeOutputDirToken(preferredDirOverride ?? "") || (mostFrequent(dirs) ?? "tmp")
  const knownTopDirs = new Set(dirs.map(d => d.split("/")[0]).filter(Boolean))
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
    const scopedWriteRoot = wsRoot && (wsRoot.startsWith("/") || /^[A-Za-z]:[\\/]/.test(wsRoot))
      ? `${wsRoot}/${preferredDir}`
      : preferredDir
    ;(step.executionContext as unknown as { allowedWriteRoots: readonly string[] }).allowedWriteRoots = [scopedWriteRoot]

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
    ;(step.executionContext as unknown as { requiredSourceArtifacts: readonly string[] }).requiredSourceArtifacts = [...new Set(normalizedSources)]
  }
}

// ============================================================================
// Contract injection
// ============================================================================

export function injectSharedDataContract(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )
  const jsWriters = subagentSteps.filter(s => s.executionContext.targetArtifacts.some(a => /\.js$/i.test(a)))
  if (jsWriters.length < 2) return

  const FORMAT_SPEC_RE = /\b(?:format|structure|schema|interface|shape|object\s*\{|array\s*of|record\s*of|map\s*of|canonical\s+data\s+contract)\b/i
  if (jsWriters.some(s => FORMAT_SPEC_RE.test(s.objective))) return

  const owner = jsWriters[0]
  ;(owner as { objective: string }).objective =
    `${owner.objective}\n\n` +
    `Shared data contract: define one canonical state schema (keys, types, and example payload), ` +
    `and ensure all related modules consume that exact schema consistently.`

  if (!owner.acceptanceCriteria.some(c => /shared data contract|schema|canonical state/i.test(c))) {
    ;(owner as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
      ...owner.acceptanceCriteria,
      "Defines and documents a canonical shared data contract (state schema + field types) used by all dependent modules.",
    ]
  }
}

export function injectSharedStateOwnershipContract(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )
  const jsWriters = subagentSteps.filter(s => s.executionContext.targetArtifacts.some(a => /\.js$/i.test(a)))
  if (jsWriters.length < 2) return

  const owner = [...jsWriters].sort((a, b) => {
    const aCount = a.executionContext.targetArtifacts.filter(x => /\.js$/i.test(x)).length
    const bCount = b.executionContext.targetArtifacts.filter(x => /\.js$/i.test(x)).length
    return bCount - aCount
  })[0]
  if (!owner) return

  const ownerArtifact = owner.executionContext.targetArtifacts.find(a => /\.js$/i.test(a))
  if (!ownerArtifact) return

  const contract = {
    contractId: `shared-state:${ownerArtifact}`,
    ownerStepName: owner.name,
    ownerArtifactPath: ownerArtifact,
    schema: "Single shared state object documented by owner file; consumers must read and use that schema without redefining it.",
    mutationPolicy: "owner-only" as const,
  }

  for (const step of jsWriters) {
    ;(step.executionContext as unknown as { sharedStateContract?: typeof contract }).sharedStateContract = contract

    if (step.name !== owner.name) {
      const required = new Set(step.executionContext.requiredSourceArtifacts)
      required.add(ownerArtifact)
      ;(step.executionContext as unknown as { requiredSourceArtifacts: readonly string[] }).requiredSourceArtifacts = [...required]

      ;(step as { objective: string }).objective =
        `${step.objective}\n\nShared state contract (${contract.contractId}): ` +
        `READ and consume state from ${ownerArtifact}. Do NOT mutate ${ownerArtifact} or redefine the schema in this step.`
    } else {
      ;(step as { objective: string }).objective =
        `${step.objective}\n\nShared state contract (${contract.contractId}): ` +
        `You are the sole state owner. Define and document the canonical schema in ${ownerArtifact}.`
    }
  }
}

export function injectDependencyWiringCriteria(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  for (const step of subagentSteps) {
    const hasConsumerArtifact = step.executionContext.targetArtifacts.some(
      a => /\.(?:html?|xhtml|xml|md|markdown|svg)$/i.test(a),
    )
    if (!hasConsumerArtifact) continue

    const ownedDependencyBasenames = step.executionContext.targetArtifacts
      .filter(a => /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|wasm)$/i.test(a))
      .map(a => a.split("/").pop() ?? a)
    if (ownedDependencyBasenames.length === 0) continue

    const hasWiringCriterion = step.acceptanceCriteria.some(
      c => /\b(?:load|import|include|link|reference|wire|attach|depends?\s+on|hook(?:s|ed)?\s+up)\b/i.test(c),
    )
    if (!hasWiringCriterion) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        `Consumer artifacts explicitly load/reference dependency artifacts: ${[...new Set(ownedDependencyBasenames)].join(", ")}.`,
      ]
    }
  }
}

export function injectBrowserRuntimeContracts(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  const htmlOwners = subagentSteps.filter(step =>
    step.executionContext.targetArtifacts.some(artifact => /\.(?:html?|xhtml)$/i.test(artifact)),
  )
  const jsWriters = subagentSteps.filter(step =>
    step.executionContext.targetArtifacts.some(artifact => /\.js$/i.test(artifact)),
  )

  if (htmlOwners.length === 0 || jsWriters.length === 0) return

  const jsArtifacts = uniqueList(jsWriters.flatMap(step =>
    step.executionContext.targetArtifacts.filter(artifact => /\.js$/i.test(artifact)),
  ))
  const jsBasenames = uniqueList(jsArtifacts.map(artifact => artifact.split("/").pop() ?? artifact))
  if (jsBasenames.length === 0) return

  const browserModuleInstruction =
    `Browser runtime contract: runtime JS must use ES modules consistently for ${jsBasenames.join(", ")}. ` +
    `Use \`<script type="module">\` in HTML and use \`export\`/\`import\` for every cross-file browser dependency. ` +
    `Never use classic scripts, \`window.X\` globals, \`module.exports\`, or \`require()\` in browser-loaded files.`

  for (const step of htmlOwners) {
    if (!/script|type="module"|import\s|load.*\.js/i.test(step.objective)) {
      ;(step as { objective: string }).objective =
        `${step.objective}\n\nEntrypoint wiring contract: this HTML entrypoint must explicitly load the runtime entry module(s) for ${jsBasenames.join(", ")} using \`<script type="module" src="...">\`. ` +
        `Every browser runtime file must be reachable from those entry module imports so the page actually loads the full runtime graph.`
    }

    if (!step.acceptanceCriteria.some(criterion => /script tag|type="module"|load.*\.js|runtime artifacts|entry module/i.test(criterion))) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        `Entrypoint HTML loads the runtime entry module(s) with <script type="module"> and reaches the runtime files ${jsBasenames.join(", ")} through direct module loading or imports.`,
      ]
    }
  }

  for (const step of jsWriters) {
    if (!step.objective.includes("Browser runtime contract: runtime JS must use ES modules consistently")) {
      ;(step as { objective: string }).objective = `${step.objective}\n\n${browserModuleInstruction}`
    }

    if (!step.acceptanceCriteria.includes("Uses ES modules consistently in browser runtime files; cross-file dependencies use import/export and no CommonJS or window globals.")) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        "Uses ES modules consistently in browser runtime files; cross-file dependencies use import/export and no CommonJS or window globals.",
      ]
    }
  }
}

export function injectHelperDependencyContracts(plan: Plan): void {
  const codeWriterSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  ).filter(step =>
    step.executionContext.targetArtifacts.some(artifact =>
      /\.(?:js|jsx|mjs|cjs|ts|tsx|py|rb|php|java|cs|go|rs|swift|kt)$/i.test(artifact),
    ),
  )

  for (const step of codeWriterSteps) {
    if (!/defined in the same file|imported explicitly|dangling references|undefined helper/i.test(step.objective)) {
      ;(step as { objective: string }).objective =
        `${step.objective}\n\n` +
        `Dependency closure contract: every non-builtin symbol this step's code calls or references must be either defined in the same file or imported explicitly from declared dependency artifacts. ` +
        `Do NOT leave dangling helper calls, undefined constants, or placeholder cross-file references.`
    }

    if (!step.acceptanceCriteria.some(criterion => /defined in the same file|imported explicitly|dangling helper|undefined helper|dependency closure/i.test(criterion))) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        "Every non-builtin symbol used by the produced code is either defined in the same file or imported explicitly from declared dependency artifacts; no dangling helper references remain.",
      ]
    }
  }
}

export function injectVisualStyleContracts(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  const styleSteps = subagentSteps.filter(step =>
    step.executionContext.targetArtifacts.some(artifact => /\.(?:css|scss|sass|less)$/i.test(artifact)),
  )
  const browserSteps = subagentSteps.filter(step =>
    step.executionContext.targetArtifacts.some(artifact => /\.(?:html?|js|jsx|ts|tsx|mjs)$/i.test(artifact)),
  )

  if (styleSteps.length === 0 || browserSteps.length === 0) return

  for (const step of browserSteps) {
    if (!/interaction state|visual feedback|css classes|row\/column parity|nth-child/i.test(step.objective)) {
      ;(step as { objective: string }).objective =
        `${step.objective}\n\n` +
        `Visual integration contract: every CSS class referenced by the HTML/JS for interaction state or visual feedback must have matching stylesheet rules in the related CSS artifacts. ` +
        `For 2D board/grid cell alternation, use coordinate-aware parity (row/column or equivalent data model), not flat nth-child striping across a linear DOM list.`
    }

    if (!step.acceptanceCriteria.some(criterion => /css class|visual feedback|row\/column parity|nth-child|interaction state/i.test(criterion))) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        "Interaction-state and visual-feedback CSS classes referenced by the UI are defined in related stylesheets, and 2D alternating board/grid visuals use coordinate-aware parity rather than flat nth-child striping.",
      ]
    }
  }
}

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
export { inferOutputDir, remediateValidationErrors } from "./index-remediate.js"
