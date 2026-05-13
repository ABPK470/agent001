/**
 * Repair-instruction and escalation-goal builders for the coherent bundle
 * pipeline. Extracted from coherent.ts.
 *
 * @module
 */

import type {
    CoherentSolutionBundle,
    VerifierDecision,
    VerifierIssue,
} from "../types.js"

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

export function collectDecisionIssues(decision: VerifierDecision): string[] {
  return uniqueStrings([
    ...decision.steps
      .filter((step) => step.outcome !== "pass")
      .flatMap((step) => step.issues),
    ...decision.unresolvedItems,
    ...decision.systemChecks?.map((check) => check.summary) ?? [],
  ])
}

export function collectAffectedArtifacts(decision: VerifierDecision): string[] {
  return uniqueStrings(
    decision.steps.flatMap((step) =>
      step.issueDetails?.flatMap((issue) => issue.affectedArtifacts) ?? [],
    ),
  )
}

function formatRepairFocus(issue: VerifierIssue): string {
  const affected = issue.affectedArtifacts.length > 0 ? ` [${issue.affectedArtifacts.join(", ")}]` : ""
  return `- ${issue.summary}${affected}`
}

export function buildCoherentRepairInstructions(
  bundle: CoherentSolutionBundle,
  decision: VerifierDecision,
  repairAttempt: number,
): string {
  const issues = collectDecisionIssues(decision)
  const focusedIssues = uniqueStrings(
    decision.steps.flatMap((step) =>
      step.issueDetails?.map((issue) => formatRepairFocus(issue)) ?? [],
    ),
  )
  const affectedArtifacts = collectAffectedArtifacts(decision)
  const sharedContracts: string[] = bundle.sharedContracts?.map((contract) => `${contract.name}: ${contract.description}`) ?? []
  const invariants: string[] = bundle.invariants?.map((invariant) => `${invariant.id}: ${invariant.description}`) ?? []

  // Detect browser module architecture errors — when present, targeted repair is
  // impossible without restructuring (the module import error is constitutional,
  // not a logic bug). Relax the "do not redesign" constraint for those cases.
  const allIssueText = issues.concat(focusedIssues).join(" ").toLowerCase()
  const hasBrowserModuleError =
    /module mismatch|cannot use import statement|import.*outside.*module|type.*module/.test(allIssueText)

  return [
    `COHERENT REPAIR REQUIRED — attempt ${repairAttempt}.`,
    `Preserve the existing architecture: ${bundle.architecture}`,
    hasBrowserModuleError
      ? [
          `ARCHITECTURE CORRECTION REQUIRED: a browser ES module error was detected.`,
          `You MUST fix the module loading strategy — choose one of:`,
          `  (a) Change all HTML <script> tags for the affected files to use type="module" (e.g. <script type="module" src="chess.js">), ensuring the HTML loads every file that uses import/export as a module.`,
          `  (b) Remove all import/export statements and inline helper code directly into the entry file — this produces a single self-contained script that works in any browser context.`,
          `Both approaches are acceptable. Whichever you choose, make ALL affected files consistent (HTML + every JS file).`,
        ].join("\n")
      : `Do NOT redesign or decompose the solution. Perform targeted repairs inside the existing coherent bundle first.`,
    `Artifacts in scope: ${bundle.artifacts.map((artifact) => artifact.path).join(", ")}`,
    affectedArtifacts.length > 0 ? `Focus first on: ${affectedArtifacts.join(", ")}` : "Focus first on the artifacts implicated by the verifier findings.",
    sharedContracts.length > 0 ? `Shared contracts to preserve:\n${sharedContracts.map((item: string) => `- ${item}`).join("\n")}` : "",
    invariants.length > 0 ? `System invariants to preserve:\n${invariants.map((item: string) => `- ${item}`).join("\n")}` : "",
    focusedIssues.length > 0
      ? `Verifier findings:\n${focusedIssues.join("\n")}`
      : `Verifier findings:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    `Required workflow:`,
    `1. Read the affected files before modifying them.`,
    `2. Make the smallest repair that fixes the verified issue.`,
    `3. Preserve file interfaces, imports, and contracts unless the verifier evidence proves they are wrong.`,
    `4. Re-read the repaired files and verify behavior before finishing.`,
    `HARD CONSTRAINTS — violation causes immediate failure:`,
    `- Do NOT start server processes (node server.js, npm start, etc.) to verify code — the backend will be started by the user separately.`,
    `- Do NOT run package installation commands (npm install, yarn add, pnpm add, bun add, etc.) — dependencies must be declared in package.json files, not installed live.`,
    `- If browser_check shows ERR_CONNECTION_REFUSED to a local API, that means the backend is not running — this is expected and NOT a code bug to fix.`,
    `Do not ask the user whether to continue. Repair now.`,
  ].filter(Boolean).join("\n\n")
}

export function buildCoherentPlannerEscalationGoal(
  originalGoal: string,
  bundle: CoherentSolutionBundle,
  decision: VerifierDecision,
): string {
  const issues = collectDecisionIssues(decision)
  return [
    `Repair the existing coherent bundle using structured planner coordination.`,
    `Original goal: ${originalGoal}`,
    `This is existing-code repair, not greenfield generation.`,
    `Preserve this architecture unless evidence proves a specific interface is broken: ${bundle.architecture}`,
    `Current artifacts: ${bundle.artifacts.map((artifact) => artifact.path).join(", ")}`,
    `Verified issues to fix:`,
    ...issues.map((issue) => `- ${issue}`),
    `Produce a repair plan that applies the smallest coordinated fixes necessary across the existing artifacts.`,
  ].join("\n")
}

export function summarizeCoherentVerifierDecision(decision: VerifierDecision): {
  overall: VerifierDecision["overall"]
  confidence: number
  issueCount: number
  systemCheckCount: number
  issues: readonly string[]
  affectedArtifacts: readonly string[]
} {
  const issues = collectDecisionIssues(decision)
  const affectedArtifacts = collectAffectedArtifacts(decision)
  return {
    overall: decision.overall,
    confidence: decision.confidence,
    issueCount: issues.length,
    systemCheckCount: decision.systemChecks?.length ?? 0,
    issues,
    affectedArtifacts,
  }
}
