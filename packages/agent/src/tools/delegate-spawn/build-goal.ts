/**
 * Build the child agent's goal prompt from a planner step + envelope.
 * Extracted from spawn-for-plan.ts.
 *
 * @module
 */

import type { ExecutionEnvelope, SubagentTaskStep } from "../../planner/index.js"

export function buildPlanChildGoal(
  step: SubagentTaskStep,
  normalizedEnvelope: ExecutionEnvelope,
): string {
  const goalParts: string[] = [
    `## Workspace — READ THIS FIRST\nYou are working in: ${normalizedEnvelope.workspaceRoot}\nAll file paths are relative to this directory. Use relative paths (e.g. "tmp/index.html") with read_file/write_file.\nWrite scope: ${normalizedEnvelope.allowedWriteRoots.join(", ") || normalizedEnvelope.workspaceRoot}`,
  ]

  if (normalizedEnvelope.requiredSourceArtifacts.length > 0) {
    goalParts.push(
      `## Source Files — READ THESE FIRST (MANDATORY)\nThese files ALREADY EXIST on disk, created by prior steps. You are BUILDING ON TOP of this work.\nYou MUST read each of these files with read_file BEFORE writing any code.\nDo NOT rewrite or replace these files unless they are also listed in your Target Files.\n${normalizedEnvelope.requiredSourceArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  goalParts.push(`## Objective\n${step.objective}`)

  const hasBlueprintSource = normalizedEnvelope.requiredSourceArtifacts.some(
    a => /BLUEPRINT\.md$/i.test(a),
  )
  if (hasBlueprintSource) {
    goalParts.push(
      `## BLUEPRINT CONTRACT — MANDATORY\nThe BLUEPRINT.md file in your Source Files defines function signatures AND algorithmic contracts.\nYou MUST implement EVERY case listed in each function's contract. A function named "validateMove" that lists 6 piece types means you implement ALL 6 — not 1-2 with a catch-all return.\nA function named "checkGameStatus" that lists checkmate, stalemate, and draw conditions means you implement ALL of them — not just "return 'ongoing'".\nFailing to implement all contract cases = STUB = REJECTION.`,
    )
  }

  if (step.inputContract) {
    goalParts.push(`## Input Context\n${step.inputContract}`)
  }

  if (step.acceptanceCriteria.length > 0) {
    goalParts.push(
      `## Acceptance Criteria (ALL must be met)\n${step.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    )
  }

  if (normalizedEnvelope.targetArtifacts.length > 0) {
    goalParts.push(
      `## Target Files\nYou are responsible for creating/modifying:\n${normalizedEnvelope.targetArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.upstreamAcceptedArtifacts?.length ?? 0) > 0) {
    goalParts.push(
      `## Accepted Upstream Artifacts\nThese artifacts are already verified and safe to rely on:\n${normalizedEnvelope.upstreamAcceptedArtifacts!.map(a => `- ${a}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.unresolvedDependencyBlockers?.length ?? 0) > 0) {
    goalParts.push(
      `## Dependency Blockers\nDo NOT claim completion for work that depends on these unresolved blockers:\n${normalizedEnvelope.unresolvedDependencyBlockers!.map(item => `- ${item}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.requiredChecks?.length ?? 0) > 0) {
    goalParts.push(
      `## Required Checks Before Completion\nYou must run or reason through these checks before finishing:\n${normalizedEnvelope.requiredChecks!.map(item => `- ${item}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.repairContext?.goals.length ?? 0) > 0 || (normalizedEnvelope.repairContext?.dependencyGoals.length ?? 0) > 0) {
    goalParts.push(
      `## Structured Repair Payload\nMode: ${normalizedEnvelope.repairContext?.mode ?? "initial"}\n` +
      `Owned Repair Goals:\n${(normalizedEnvelope.repairContext?.goals.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.goals.map(goal => `- [${goal.issueCode}] ${goal.summary} (${goal.repairClass}, ${goal.severity}, ${(goal.confidence * 100).toFixed(0)}%, owner=${goal.primaryOwner ?? "none"}, mode=${goal.ownershipMode}, suspects=${goal.suspectedOwners.join(", ") || "none"})`).join("\n")
        : "- none"}\n` +
      `Dependency Context Goals:\n${(normalizedEnvelope.repairContext?.dependencyGoals.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.dependencyGoals.map(goal => `- [${goal.issueCode}] ${goal.summary} (${(goal.confidence * 100).toFixed(0)}%, mode=${goal.ownershipMode}, suspects=${goal.suspectedOwners.join(", ") || "none"})`).join("\n")
        : "- none"}\n` +
      `Required Accepted Artifacts:\n${(normalizedEnvelope.repairContext?.requiredAcceptedArtifacts.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.requiredAcceptedArtifacts.map(artifact => `- ${artifact}`).join("\n")
        : "- none"}`,
    )

    if (normalizedEnvelope.repairContext?.preserveArchitecture) {
      goalParts.push(
        `## Architecture Preservation Policy\n` +
        `Preserve Architecture: yes\n` +
        `Frozen Architecture: ${normalizedEnvelope.repairContext.architectureSummary ?? "unspecified"}\n` +
        `Shared Contracts:\n${(normalizedEnvelope.repairContext.sharedContracts?.length ?? 0) > 0
          ? normalizedEnvelope.repairContext.sharedContracts!.map((contract) => `- ${contract.name}: ${contract.description}`).join("\n")
          : "- none"}\n` +
        `System Invariants:\n${(normalizedEnvelope.repairContext.invariants?.length ?? 0) > 0
          ? normalizedEnvelope.repairContext.invariants!.map((invariant) => `- ${invariant.id}: ${invariant.description}`).join("\n")
          : "- none"}\n` +
        `Repair policy: fix the verified issues inside the frozen architecture first. Do not redesign interfaces or redistribute ownership unless the evidence proves the architecture itself is broken.`,
      )
    }
  }

  goalParts.push(
    `## Step Contract\n` +
    `Step Name: ${step.name}\n` +
    `Role: ${normalizedEnvelope.role ?? "writer"}\n` +
    `Effect Class: ${normalizedEnvelope.effectClass}\n` +
    `Verification Mode: ${normalizedEnvelope.verificationMode}\n` +
    `Owned Artifacts:\n${normalizedEnvelope.targetArtifacts.map(a => `- ${a}`).join("\n") || "- none"}\n` +
    `Readable Context Artifacts:\n${normalizedEnvelope.requiredSourceArtifacts.map(a => `- ${a}`).join("\n") || "- none"}\n` +
    `Forbidden Writes:\n${(normalizedEnvelope.forbiddenArtifacts?.length ?? 0) > 0
      ? normalizedEnvelope.forbiddenArtifacts!.map(a => `- ${a}`).join("\n")
      : "- any artifact not listed under Owned Artifacts unless explicitly allowed as integration context."}`,
  )

  return goalParts.join("\n\n")
}
