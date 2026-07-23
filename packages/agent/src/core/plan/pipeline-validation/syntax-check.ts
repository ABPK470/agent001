/**
 * Post-step syntax validation — runs `node --check` on JS targets and
 * mutated JS files to catch syntax errors immediately after a subagent
 * step completes.
 *
 * @module
 */

import type { ToolCallRecord } from "../../../tools/_shared/result.js"
import type { SubagentStepValidationContext } from "../internal/pipeline-repair.js"
import type { SubagentTaskStep } from "../types.js"

export async function runPostStepSyntaxValidation(
  step: SubagentTaskStep,
  toolCalls: readonly ToolCallRecord[],
  validationCtx?: SubagentStepValidationContext
): Promise<string[]> {
  const errors: string[] = []
  const wsRoot = validationCtx?.workspaceRoot

  const jsTargets = step.executionContext.targetArtifacts.filter((a) => /\.js$/i.test(a))
  const mutatedJsPaths = new Set<string>()

  for (const c of toolCalls) {
    if (c.isError) continue
    if (c.name !== "write_file" && c.name !== "replace_in_file") continue
    const path = typeof c.args.path === "string" ? c.args.path : ""
    if (/\.js$/i.test(path)) mutatedJsPaths.add(path)
  }

  const pathsToCheck = new Set<string>([...jsTargets, ...mutatedJsPaths])
  if (pathsToCheck.size === 0) return errors

  const { execSync } = await import("node:child_process")

  for (const artifact of pathsToCheck) {
    let checkPath = artifact
    if (wsRoot && !checkPath.startsWith("/")) {
      checkPath = wsRoot.endsWith("/") ? `${wsRoot}${checkPath}` : `${wsRoot}/${checkPath}`
    }

    try {
      const { accessSync } = await import("node:fs")
      accessSync(checkPath)

      execSync(`node --check ${JSON.stringify(checkPath)}`, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"]
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? ((err as { stderr?: string }).stderr ?? err.message) : String(err)
      if (/SyntaxError|Unexpected token|Unexpected identifier/i.test(errMsg)) {
        const errorLines = errMsg.trim().split("\n").slice(0, 5).join(" | ")
        errors.push(`Syntax error in "${artifact}": ${errorLines}`)
      }
    }
  }

  return errors
}
