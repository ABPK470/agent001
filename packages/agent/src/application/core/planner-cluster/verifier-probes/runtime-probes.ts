import { VerificationMode } from "../../domain/index.js"
/**
 * Runtime probes for subagent assessment — browser_check on HTML artifacts
 * and `npm test` execution when verificationMode is run_tests.
 *
 * @module
 */

import type { Tool } from "../../types.js"
import { executeToolForText } from "../internal/verifier-io.js"
import type { SubagentTaskStep } from "../types.js"

export interface BrowserCheckOutcome {
  passed: boolean
  htmlArtifacts: string[]
}

export async function runBrowserCheckProbe(
  step: SubagentTaskStep,
  toolMap: Map<string, Tool>,
  probeCache: ReadonlyMap<string, { found: boolean; resolvedPath: string }>,
  wsRoot: string | undefined,
  issues: string[],
  executedModalities: Set<string>,
): Promise<BrowserCheckOutcome> {
  const htmlArtifacts = step.executionContext.targetArtifacts.filter(
    a => a.endsWith(".html") || a.endsWith(".htm"),
  )
  if (htmlArtifacts.length === 0) {
    return { passed: false, htmlArtifacts }
  }
  const browserCheck = toolMap.get("browser_check")
  if (!browserCheck) {
    issues.push("VERIFICATION MODALITY GAP: HTML artifacts exist but browser_check tool is unavailable, so runtime verification could not run")
    return { passed: false, htmlArtifacts }
  }

  let anyBrowserFailure = false
  for (const html of htmlArtifacts) {
    const cached = probeCache.get(html)
    let browserPath = cached?.found ? cached.resolvedPath : html
    if (wsRoot && browserPath.startsWith(wsRoot)) {
      browserPath = browserPath.slice(wsRoot.length).replace(/^\//, "")
    }
    try {
      executedModalities.add("runtime")
      const result = await executeToolForText(browserCheck, { path: browserPath })
      if (/error|fail|exception/i.test(result) && !/no errors/i.test(result)) {
        const isBackendNotRunningLine = (ln: string): boolean =>
          /ERR_CONNECTION_REFUSED|net::ERR_CONNECTION|Failed to fetch/i.test(ln) ||
          (/(404|Not Found)/i.test(ln) && /(localhost|127\.0\.0\.1)[:/]/i.test(ln))
        const allErrorsAreBackendNotRunning = result
          .split("\n")
          .filter(ln => /error|fail|exception/i.test(ln))
          .every(ln => isBackendNotRunningLine(ln))
        if (!allErrorsAreBackendNotRunning) {
          issues.push(`Browser check for "${browserPath}" reported errors: ${result.slice(0, 300)}`)
          anyBrowserFailure = true
        }
      }
    } catch {
      issues.push(`Browser check failed for "${browserPath}"`)
      anyBrowserFailure = true
    }
  }
  return { passed: !anyBrowserFailure, htmlArtifacts }
}

export async function runTestsProbe(
  step: SubagentTaskStep,
  toolMap: Map<string, Tool>,
  issues: string[],
  executedModalities: Set<string>,
): Promise<void> {
  if (step.executionContext.verificationMode !== VerificationMode.RunTests) return
  const runCmd = toolMap.get("run_command")
  if (!runCmd) return
  try {
    executedModalities.add("runtime")
    const result = await executeToolForText(runCmd, { command: "npm test 2>&1 || exit 0" })
    if (/\d+\s+fail|FAIL\s|tests?\s+failed/i.test(result) && !/0 failed/i.test(result)) {
      issues.push(`Test run reported failures: ${result.slice(0, 300)}`)
    }
  } catch {
    issues.push("Test run failed to execute")
  }
}
