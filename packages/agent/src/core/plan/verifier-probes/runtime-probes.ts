import { VerificationMode } from "../../domain/index.js"
/**
 * Runtime probes for subagent assessment — `npm test` execution when
 * verificationMode is run_tests.
 *
 * @module
 */

import type { Tool } from "../../types.js"
import { executeToolForText } from "../internal/verifier-io.js"
import type { SubagentTaskStep } from "../types.js"

export async function runTestsProbe(
  step: SubagentTaskStep,
  toolMap: Map<string, Tool>,
  issues: string[],
  executedModalities: Set<string>
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
