/**
 * Contract-injection helpers — augment plan steps with shared-data, browser-
 * runtime, helper-dependency, and visual-style contracts. Extracted from
 * index-normalize.ts.
 *
 * @module
 */

import { uniqueList } from "../normalize/index.js"
import type { Plan, SubagentTaskStep } from "../types.js"

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
