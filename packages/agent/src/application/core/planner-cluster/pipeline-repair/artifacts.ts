/**
 * Artifact family detection, language guidance, and issue repair actions.
 *
 * @module
 */

import type { Tool } from "../../types.js"
import type { Plan, SubagentTaskStep } from "../types.js"

// ============================================================================
// Internal types
// ============================================================================

export interface SubagentStepValidationContext {
  plan: Plan
  readFileTool?: Tool
  workspaceRoot?: string
  knownProjectArtifacts?: readonly string[]
}

export type ArtifactFamily =
  | "javascript"
  | "typescript"
  | "python"
  | "sql"
  | "html"
  | "posix-shell"
  | "powershell"
  | "windows-cmd"

// ============================================================================
// Artifact family detection + language guidance
// ============================================================================

export function detectArtifactFamilies(artifacts: readonly string[]): Set<ArtifactFamily> {
  const families = new Set<ArtifactFamily>()
  for (const artifact of artifacts) {
    const lower = artifact.toLowerCase()
    if (/(?:\.jsx?|\.mjs|\.cjs)$/.test(lower)) families.add("javascript")
    if (/(?:\.tsx?|\.mts|\.cts)$/.test(lower)) families.add("typescript")
    if (/\.py$/.test(lower)) families.add("python")
    if (/\.sql$/.test(lower)) families.add("sql")
    if (/\.html?$/.test(lower)) families.add("html")
    if (/\.(?:sh|bash|zsh|fish)$/.test(lower) || /(?:^|\/)makefile$/i.test(artifact)) families.add("posix-shell")
    if (/\.(?:ps1|psm1|psd1)$/.test(lower)) families.add("powershell")
    if (/\.(?:cmd|bat)$/.test(lower)) families.add("windows-cmd")
  }
  return families
}

export function buildLanguageRepairGuidance(families: ReadonlySet<ArtifactFamily>): string[] {
  const guidance: string[] = []
  if (families.has("javascript") || families.has("typescript")) {
    guidance.push("JS/TS: preserve module exports, import paths, and public function signatures; make surgical edits instead of rewriting working files")
  }
  if (families.has("python")) {
    guidance.push("Python: preserve function names and call contracts exactly; fix indentation, imports, and control flow without changing the declared API")
  }
  if (families.has("sql")) {
    guidance.push("SQL: preserve schema/table/column names from the spec exactly; repair query logic and DDL/DML semantics without inventing new schema")
  }
  if (families.has("html")) {
    guidance.push("HTML/UI: preserve declared ids, classes, data attributes, and referenced asset paths exactly as the spec defines them")
  }
  if (families.has("posix-shell")) {
    guidance.push("POSIX shell: keep commands portable for sh/bash/zsh where possible, quote paths safely, and avoid non-portable syntax unless the target shell explicitly requires it")
  }
  if (families.has("powershell")) {
    guidance.push("PowerShell: preserve cmdlet/function names and parameter contracts, use native PowerShell syntax instead of POSIX shell idioms, and keep Windows path handling explicit")
  }
  if (families.has("windows-cmd")) {
    guidance.push("Windows CMD: use cmd.exe syntax, preserve batch labels and variable expansion rules, and avoid injecting Bash or PowerShell syntax into .cmd/.bat files")
  }
  return guidance
}

// ============================================================================
// Issue repair actions
// ============================================================================

export function buildIssueRepairActions(step: SubagentTaskStep, feedback: readonly string[]): string[] {
  const actions: string[] = []

  for (const issue of feedback) {
    const cleanIssue = issue.replace(/^\[non-blocking\]\s*/i, "")

    if (/SPEC FUNCTION MISMATCH:/i.test(cleanIssue)) {
      const match = cleanIssue.match(/SPEC FUNCTION MISMATCH:\s+(.+?)\s+is missing blueprint functions\s+(.+?)\s+from\s+(.+)$/i)
      if (match) {
        const artifactPath = match[1].trim()
        if (/\.(?:html?|css|scss|sass|less|md|markdown|txt|rst|adoc)$/i.test(artifactPath)) {
          actions.push(
            `Do NOT implement runtime functions in ${artifactPath}; reconcile the contract and wiring so ${artifactPath} only carries structure/presentation responsibilities and the missing functions are owned by executable source artifacts.`,
          )
        } else {
          actions.push(`Read ${match[3]} and ${artifactPath}, then implement exactly these missing functions in ${artifactPath}: ${match[2]}`)
        }
      } else {
        actions.push("Read the blueprint and target artifact, then implement every missing function signature exactly as declared")
      }
      continue
    }

    if (/SPEC STRUCTURE MISMATCH:/i.test(cleanIssue)) {
      const match = cleanIssue.match(/SPEC STRUCTURE MISMATCH:\s+(.+?)\s+is missing blueprint structure markers\s+(.+?)\s+from\s+(.+)$/i)
      if (match) {
        actions.push(`Update ${match[1]} so it contains these required structural elements from ${match[3]}: ${match[2]}`)
      } else {
        actions.push("Align the produced artifact with the structural elements declared in the blueprint before changing unrelated code")
      }
      continue
    }

    if (/SPEC MAPPING MISSING:/i.test(cleanIssue)) {
      actions.push("Map each target artifact to a concrete blueprint file/section before editing; do not invent files or responsibilities not declared in the spec")
      continue
    }

    if (/SPEC PATH MISMATCH:/i.test(cleanIssue) || /PATH MISMATCH:/i.test(cleanIssue)) {
      actions.push("Write to the exact target path from the plan; do not place the fix in an alternate directory or sibling file")
      continue
    }

    if (/PROCESS AUDIT FAILED:.*never read/i.test(cleanIssue)) {
      actions.push("First read BLUEPRINT.md before making any change, then read each target artifact you will modify, and only then start mutations")
      continue
    }

    if (/PROCESS AUDIT FAILED:.*after starting file mutations/i.test(cleanIssue)) {
      actions.push("Reorder the workflow: read spec first, read current target files second, mutate files only after both reads are complete")
      continue
    }

    if (/PROCESS AUDIT WEAK:/i.test(cleanIssue)) {
      actions.push("Read the existing target files before editing so the next attempt patches current code instead of regenerating blindly")
      continue
    }

    if (/Placeholder\/stub code|stub|placeholder|degeneration|empty function|trivial return|returns constant/i.test(cleanIssue)) {
      actions.push("Replace every stub or placeholder body with real executable logic; keep the signature but rewrite the body completely")
      continue
    }

    if (/Syntax error/i.test(cleanIssue)) {
      actions.push("Fix syntax and parse errors first so the artifact can be executed or checked before addressing secondary issues")
      continue
    }

    if (/Browser check/i.test(cleanIssue)) {
      actions.push("Repair the runtime failure reported by browser verification, then re-check the referenced UI wiring and asset loading paths")
      continue
    }

    if (/shared-state contract/i.test(cleanIssue)) {
      actions.push("Consume the declared shared-state owner artifact exactly as required; do not duplicate or fork shared state logic")
      continue
    }

    if (/SCOPE VIOLATION/i.test(cleanIssue)) {
      const forbiddenMatch = cleanIssue.match(/path\s+["']([^"']+)["']\s+is outside/i)
      const allowedMatch = cleanIssue.match(/Allowed targetArtifacts[^:]*:\s*([^.]+)/i)
      const ownedFiles = step.executionContext.targetArtifacts
      if (forbiddenMatch && allowedMatch) {
        const forbidden = forbiddenMatch[1]
        const allowed = allowedMatch[1].trim()
        actions.push(
          `SCOPE CONSTRAINT VIOLATION: you tried to write "${forbidden}" which is NOT one of your target files. ` +
          `YOUR ONLY ALLOWED TARGET FILES ARE: ${allowed}. ` +
          `Do NOT write "${forbidden}" under any circumstances — it is owned by a different pipeline step. ` +
          `Focus exclusively on writing: ${ownedFiles.join(", ")}.`,
        )
      } else if (ownedFiles.length > 0) {
        actions.push(
          `SCOPE CONSTRAINT: your ONLY allowed target files are: ${ownedFiles.join(", ")}. ` +
          `Do not write or modify any other file. If the task feels incomplete without writing additional files, ` +
          `ignore that feeling — the other files are the responsibility of a different pipeline step.`,
        )
      } else {
        actions.push("Edit only this step's owned target artifacts unless a required source artifact explicitly allows integration wiring changes")
      }
      continue
    }

    if (/VERIFICATION MODALITY GAP/i.test(cleanIssue)) {
      actions.push("Produce artifacts that are straightforward to verify deterministically: valid syntax, explicit entrypoints, and concrete file outputs")
      continue
    }
  }

  return [...new Set(actions)]
}
