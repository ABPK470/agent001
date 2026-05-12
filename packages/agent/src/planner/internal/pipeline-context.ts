/**
 * Pipeline context injection — augment subagent steps with concrete context
 * from completed dependency steps.
 *
 * Solves the "blind child" problem: without this, step N+1 has no idea
 * what step N actually produced.
 *
 * Extracted from pipeline.ts for maintainability.
 *
 * @module
 */

import type { ToolCallRecord } from "../../recovery/index.js"
import type {
    DeterministicToolStep,
    PipelineStepResult,
    Plan,
    SubagentTaskStep
} from "../types.js"

// ============================================================================
// Path extraction helpers
// ============================================================================

/** Extract file paths mentioned in child output (created/modified). */
export function extractMentionedPaths(output: string): string[] {
  const paths: string[] = []
  // Backtick-quoted paths: `path/file.ext`
  for (const m of output.matchAll(/`([^`\s]+\.[a-zA-Z0-9]+)`/g)) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  // "created/wrote/modified [to] <path>" patterns — the optional "to" is
  // critical because tool output often says "Successfully wrote to tmp/app/main.js"
  for (const m of output.matchAll(/(?:creat|writ|wrote|modif|generat|saved)\w*\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  return [...new Set(paths)]
}

export function extractMutatedPathsFromToolCalls(calls: readonly ToolCallRecord[] | undefined): string[] {
  if (!calls || calls.length === 0) return []
  const paths = new Set<string>()

  for (const c of calls) {
    if (c.isError) continue
    if (c.name !== "write_file" && c.name !== "replace_in_file" && c.name !== "append_file") continue

    const fromArgs = typeof c.args.path === "string"
      ? c.args.path
      : typeof c.args.filePath === "string"
        ? c.args.filePath
        : typeof c.args.file === "string"
          ? c.args.file
          : ""
    if (fromArgs.trim().length > 0) {
      paths.add(fromArgs)
      continue
    }

    for (const m of c.result.matchAll(/(?:wrote|created|updated|saved)\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
      if (m[1] && m[1].length < 200) paths.add(m[1])
    }
  }

  return [...paths]
}

// ============================================================================
// Dependency output summarization
// ============================================================================

/** Summarize a dependency step's output for downstream consumption. */
export function summarizeDependencyOutput(output: string, maxChars: number, toolCalls?: readonly ToolCallRecord[]): string {
  const mentionedPaths = extractMutatedPathsFromToolCalls(toolCalls)
  const parts: string[] = []

  if (mentionedPaths.length > 0) {
    parts.push(`Files created/modified: ${mentionedPaths.join(", ")}`)
  }

  // Extract the first few meaningful lines (skip blanks, markdown headers)
  const lines = output.split("\n").filter(l => l.trim().length > 0)
  const meaningfulLines = lines.slice(0, 5).join("\n")

  if (meaningfulLines.length > 0) {
    const remaining = maxChars - parts.join("\n").length - 20
    if (remaining > 100) {
      parts.push(meaningfulLines.slice(0, remaining))
    }
  }

  return parts.join("\n") || output.slice(0, maxChars)
}

// ============================================================================
// Prior context injection
// ============================================================================

export function injectPriorContext(
  step: SubagentTaskStep,
  plan: Plan,
  stepResults: ReadonlyMap<string, PipelineStepResult>,
  workspaceRoot?: string,
): SubagentTaskStep {
  const deps = step.dependsOn ?? []
  if (deps.length === 0 && !workspaceRoot) return step

  const priorSections: string[] = []

  // Collect outputs from completed dependency steps
  for (const depName of deps) {
    const depResult = stepResults.get(depName)
    if (!depResult) continue

    const depStep = plan.steps.find(s => s.name === depName)

    // agenc-core pattern: summarize rather than raw truncate
    const summary = depResult.output
      ? summarizeDependencyOutput(depResult.output, 800, depResult.toolCalls)
      : `(step ${depResult.status})`

    priorSections.push(
      `### Step "${depName}" (${depResult.status})${depStep?.stepType === "deterministic_tool" ? ` — tool: ${(depStep as DeterministicToolStep).tool}` : ""}\n${summary}`,
    )
  }

  // Build augmented inputContract with prior context
  let augmentedInput = step.inputContract || ""
  if (priorSections.length > 0) {
    augmentedInput = `## Context from completed prior steps\nThese steps have ALREADY RUN and their output files EXIST on disk. You are continuing their work — do NOT redo what they did.\n\n${priorSections.join("\n\n")}\n\n${augmentedInput}`
  }

  // Override workspaceRoot in execution context with actual value
  let executionContext = step.executionContext
  if (workspaceRoot) {
    executionContext = {
      ...executionContext,
      workspaceRoot,
      allowedReadRoots: executionContext.allowedReadRoots.length > 0
        ? executionContext.allowedReadRoots
        : [workspaceRoot],
      allowedWriteRoots: executionContext.allowedWriteRoots.length > 0
        ? executionContext.allowedWriteRoots
        : [workspaceRoot],
    }
  }

  // Augment objective with a filesystem grounding reminder
  let objective = step.objective
  if (priorSections.length > 0) {
    const priorArtifacts: string[] = []
    for (const depName of deps) {
      const depResult = stepResults.get(depName)
      const depStep = plan.steps.find(s => s.name === depName)

      const depTargetArtifacts = depStep?.stepType === "subagent_task"
        ? (depStep as SubagentTaskStep).executionContext.targetArtifacts
        : []

      if (depResult) {
        const actualPaths = extractMutatedPathsFromToolCalls(depResult.toolCalls)
        if (actualPaths.length > 0) {
          const resolvedPaths = actualPaths.map(extracted => {
            if (!extracted.includes("/") && depTargetArtifacts.length > 0) {
              const match = depTargetArtifacts.find(
                t => t.endsWith(`/${extracted}`) || t === extracted,
              )
              return match ?? extracted
            }
            return extracted
          })
          priorArtifacts.push(...resolvedPaths)
          continue
        }
      }

      if (depResult?.output) {
        const outputPaths = extractMentionedPaths(depResult.output)
        if (outputPaths.length > 0) {
          priorArtifacts.push(...outputPaths)
          continue
        }
      }

      priorArtifacts.push(...depTargetArtifacts)
    }
    if (priorArtifacts.length > 0) {
      const uniqueArtifacts = [...new Set(priorArtifacts)]
      objective = `${objective}\n\n⚠️ PRIOR WORK EXISTS — DO NOT START FROM SCRATCH:\nPrior steps have ALREADY created these files: ${uniqueArtifacts.join(", ")}.\nYou MUST:\n1. Use read_file with these EXACT paths to read each file\n2. Understand what they contain and what functions/variables they export\n3. Build ON TOP of this existing code — reference their functions, use their data structures\n4. Do NOT recreate, overwrite, or duplicate any file that is not in YOUR target files`

      const existingSource = new Set(executionContext.requiredSourceArtifacts)
      for (const artifact of uniqueArtifacts) {
        existingSource.add(artifact)
      }
      executionContext = {
        ...executionContext,
        requiredSourceArtifacts: [...existingSource],
      }
    }
  }

  return {
    ...step,
    objective,
    inputContract: augmentedInput,
    executionContext,
  }
}
