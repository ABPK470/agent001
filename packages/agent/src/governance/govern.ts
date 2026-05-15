/**
 * Governance layer — the agent runs ON the engine.
 *
 * This is where the two packages meet. The engine provides the substrate:
 *   - Audit trail: every tool call logged (who, what, when, why, result)
 *   - Policies: rules that can block or require approval for dangerous tools
 *   - Run tracking: the full agent session as an AgentRun with Steps
 *   - Domain events: every action emits events for monitoring
 *   - Execution records: performance metrics fed to the Learner
 *
 * The agent's tool-calling loop stays the same. But each tool.execute()
 * is wrapped so it goes through the engine's governance before running.
 *
 * Policy examples:
 *   { effect: "deny",             condition: "action:run_command" }  → blocks shell
 *   { effect: "require_approval", condition: "action:write_file" }  → needs human OK
 *   { effect: "allow",            condition: "action:read_file"  }  → always allowed
 */


import { Agent } from "../agent/index.js"
import {
    StepStatus,
    completeRun,
    createRun,
    failRun,
    runCompleted,
    runFailed,
    runStarted,
    startPlanning,
    startRunning,
} from "../domain/index.js"
import { type EngineServices, type GovernedResult, type RunState } from "./types.js"
import { governTool } from "./govern-tool.js"
import type { AgentConfig, LLMClient, Tool } from "../types.js"

export { governTool, type GovernToolOptions } from "./govern-tool.js"

// ── Run an agent with full governance ────────────────────────────

export async function runGoverned(
  goal: string,
  llm: LLMClient,
  tools: Tool[],
  services: EngineServices,
  config?: AgentConfig & { actor?: string },
): Promise<GovernedResult> {
  const actor = config?.actor ?? "ai-agent"

  // Create a tracked run
  const run = createRun("agent-session", { goal })
  startPlanning(run)
  startRunning(run, [])
  await services.runRepo.save(run)
  await services.eventBus.publish(runStarted(run.id, "agent-session"))

  // Audit: agent started
  await services.auditService.log({
    actor,
    action: "agent.started",
    resourceType: "AgentRun",
    resourceId: run.id,
    detail: { goal, tools: tools.map((t) => t.name) },
  })

  // Wrap every tool with governance
  const state: RunState = { run, actor, stepCounter: 0 }
  const governedTools = tools.map((t) => governTool(t, services, state))

  // Run the agent (same loop, governed tools)
  const agent = new Agent(llm, governedTools, config)
  let answer: string

  try {
    answer = await agent.run(goal)

    // Complete the run
    completeRun(run)
    await services.eventBus.publish(runCompleted(run.id))
    await services.auditService.log({
      actor,
      action: "agent.completed",
      resourceType: "AgentRun",
      resourceId: run.id,
      detail: {
        goal,
        iterations: state.stepCounter,
        answerLength: answer.length,
      },
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    failRun(run)
    await services.eventBus.publish(runFailed(run.id, errMsg))
    await services.auditService.log({
      actor,
      action: "agent.failed",
      resourceType: "AgentRun",
      resourceId: run.id,
      detail: { goal, error: errMsg, iterations: state.stepCounter },
    })
    answer = `Agent failed: ${errMsg}`
  }

  await services.runRepo.save(run)

  // Gather stats per tool
  const stats = new Map<string, { calls: number, avgMs: number, failures: number }>()
  for (const step of run.steps) {
    const existing = stats.get(step.action) ?? { calls: 0, avgMs: 0, failures: 0 }
    existing.calls++
    if (step.status === StepStatus.Failed) existing.failures++
    const duration = (step.output["durationMs"] as number) ?? 0
    existing.avgMs = Math.round(
      (existing.avgMs * (existing.calls - 1) + duration) / existing.calls,
    )
    stats.set(step.action, existing)
  }

  // Fetch full audit trail
  const auditTrail = await services.auditService.history("AgentRun", run.id)

  return { answer, run, auditTrail, stats }
}

// ── Pretty-print a governed result ───────────────────────────────

// Re-export governance report for backwards compatibility
export { printGovernanceReport } from "./report.js"
export { createEngineServices, createToolStep, type EngineServices, type GovernedResult, type RunState } from "./types.js"

