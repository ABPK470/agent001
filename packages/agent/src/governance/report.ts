/**
 * Governance report printer — console output for a GovernedResult.
 *
 * Extracted from governance.ts.
 *
 * @module
 */

import type { GovernedResult } from "./govern.js"

export function printGovernanceReport(result: GovernedResult): void {
  const { run, auditTrail, stats } = result

  console.log("\n" + "═".repeat(60))
  console.log("  GOVERNANCE REPORT")
  console.log("═".repeat(60))

  console.log(`\n  Run ID:     ${run.id}`)
  console.log(`  Status:     ${run.status}`)
  console.log(`  Steps:      ${run.steps.length} tool calls`)
  console.log(`  Started:    ${run.createdAt.toISOString()}`)
  if (run.completedAt) {
    const durationSec = (run.completedAt.getTime() - run.createdAt.getTime()) / 1000
    console.log(`  Completed:  ${run.completedAt.toISOString()} (${durationSec.toFixed(1)}s)`)
  }

  if (run.steps.length > 0) {
    console.log("\n  ── Steps ──")
    for (const step of run.steps) {
      const icon = step.status === "completed" ? "✅"
        : step.status === "failed" ? "❌"
        : "⏸️"
      const duration = step.output["durationMs"] ? ` (${step.output["durationMs"]}ms)` : ""
      console.log(`  ${icon} ${step.name} → ${step.status}${duration}`)
      if (step.error) console.log(`     Error: ${step.error}`)
    }
  }

  if (stats.size > 0) {
    console.log("\n  ── Tool Stats ──")
    for (const [tool, s] of stats) {
      console.log(
        `  ${tool}: ${s.calls} calls, avg ${s.avgMs}ms, ${s.failures} failures`,
      )
    }
  }

  if (auditTrail.length > 0) {
    console.log("\n  ── Audit Trail ──")
    for (const entry of auditTrail) {
      const time = entry.timestamp.toISOString().slice(11, 23)
      console.log(`  [${time}] ${entry.action} — ${entry.actor}`)
      if (entry.detail && Object.keys(entry.detail).length > 0) {
        const summary = Object.entries(entry.detail)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 60) : v}`)
          .join(", ")
        console.log(`             ${summary}`)
      }
    }
  }

  console.log("\n" + "═".repeat(60) + "\n")
}
