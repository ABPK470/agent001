/**
 * Governance layer — the agent runs ON the engine.
 *
 * This is where the two packages meet. The engine provides the substrate:
 *   - Audit trail: every tool call logged (who, what, when, why, result)
 *   - Policies: rules that can block or require approval for dangerous tools
 *   - Run tracking: the full agent session as a WorkflowRun with Steps
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

import { randomUUID } from "node:crypto"
import {
  type AuditEntry,
  type ExecutionRecord,
  type PolicyRule,
  type Step,
  type WorkflowRun,
  AuditService,
  Learner,
  MemoryAuditRepository,
  MemoryEventBus,
  MemoryExecutionRecordRepository,
  MemoryRunRepository,
  PolicyEffect,
  PolicyViolationError,
  RunStatus,
  RulePolicyEvaluator,
  StepStatus,
  completeRun,
  completeStep,
  createRun,
  failRun,
  failStep,
  runCompleted,
  runFailed,
  runStarted,
  startPlanning,
  startRunning,
  startStep,
  stepCompleted,
  stepFailed,
  stepStarted,
} from "@agent001/engine"
import { Agent } from "./agent.js"
import * as log from "./logger.js"
import type { AgentConfig, LLMClient, Tool } from "./types.js"

// ── Engine infrastructure ────────────────────────────────────────

export interface EngineServices {
  runRepo: InstanceType<typeof MemoryRunRepository>
  auditService: AuditService
  policyEvaluator: RulePolicyEvaluator
  learner: Learner
  eventBus: MemoryEventBus
}

/** Creates a default set of engine services (in-memory). */
export function createEngineServices(): EngineServices {
  const runRepo = new MemoryRunRepository()
  const auditRepo = new MemoryAuditRepository()
  const recordRepo = new MemoryExecutionRecordRepository()
  const eventBus = new MemoryEventBus()

  return {
    runRepo,
    auditService: new AuditService(auditRepo),
    policyEvaluator: new RulePolicyEvaluator(),
    learner: new Learner(recordRepo),
    eventBus,
  }
}

// ── Governed result ──────────────────────────────────────────────

export interface GovernedResult {
  /** The agent's final answer. */
  answer: string
  /** Full run with all steps — shows exactly what happened. */
  run: WorkflowRun
  /** Audit trail — immutable log of every action. */
  auditTrail: AuditEntry[]
  /** Execution records — performance metrics per tool call. */
  stats: Map<string, { calls: number, avgMs: number, failures: number }>
}

// ── Run state (shared between governed tools) ────────────────────

interface RunState {
  run: WorkflowRun
  actor: string
  stepCounter: number
}

// ── Build a Step for a tool call ─────────────────────────────────

function createToolStep(
  toolName: string,
  args: Record<string, unknown>,
  state: RunState,
): Step {
  const order = state.stepCounter++
  return {
    id: randomUUID(),
    definitionId: `tool-${toolName}-${order}`,
    name: `${toolName} (#${order})`,
    action: toolName,
    input: args,
    condition: null,
    onError: "continue",
    status: StepStatus.Pending,
    order,
    output: {},
    error: null,
    startedAt: null,
    completedAt: null,
  }
}

// ── Wrap a tool with governance ──────────────────────────────────

function governTool(
  tool: Tool,
  services: EngineServices,
  state: RunState,
): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,

    async execute(args: Record<string, unknown>): Promise<string> {
      const step = createToolStep(tool.name, args, state)
      state.run.steps.push(step)

      // 1. Policy check — can this tool run?
      try {
        const policyResult = await services.policyEvaluator.evaluatePreStep(
          state.run,
          step,
        )
        if (policyResult !== null) {
          // Requires approval — block the tool
          startStep(step)
          failStep(step, `Blocked by policy: ${policyResult}`)
          await services.auditService.log({
            actor: state.actor,
            action: "tool.blocked",
            resourceType: "AgentRun",
            resourceId: state.run.id,
            detail: { tool: tool.name, reason: policyResult, stepId: step.id },
          })
          await services.runRepo.save(state.run)
          return `BLOCKED: ${policyResult}. This tool call was prevented by a governance policy.`
        }
      } catch (err) {
        if (err instanceof PolicyViolationError) {
          startStep(step)
          failStep(step, `Denied by policy: ${err.message}`)
          await services.auditService.log({
            actor: state.actor,
            action: "tool.denied",
            resourceType: "AgentRun",
            resourceId: state.run.id,
            detail: { tool: tool.name, reason: err.message, stepId: step.id },
          })
          await services.runRepo.save(state.run)
          return `DENIED: ${err.message}. This action is forbidden by governance policy.`
        }
        throw err
      }

      // 2. Start step + emit event
      startStep(step)
      await services.eventBus.publish(stepStarted(state.run.id, step.id))

      // 3. Audit: tool invoked
      await services.auditService.log({
        actor: state.actor,
        action: "tool.invoked",
        resourceType: "AgentRun",
        resourceId: state.run.id,
        detail: { tool: tool.name, args, stepId: step.id },
      })

      // 4. Execute the actual tool
      const startTime = performance.now()
      try {
        const result = await tool.execute(args)
        const durationMs = Math.round(performance.now() - startTime)

        // 5. Complete step
        completeStep(step, { result, durationMs })
        await services.eventBus.publish(stepCompleted(state.run.id, step.id))

        // 6. Record execution metric
        const record: ExecutionRecord = {
          id: randomUUID(),
          runId: state.run.id,
          stepId: step.id,
          action: tool.name,
          success: true,
          durationMs,
          result: { truncated: result.slice(0, 500) },
          error: null,
          recordedAt: new Date(),
        }
        await services.learner.record(record)

        // 7. Audit: tool completed
        await services.auditService.log({
          actor: state.actor,
          action: "tool.completed",
          resourceType: "AgentRun",
          resourceId: state.run.id,
          detail: {
            tool: tool.name,
            stepId: step.id,
            durationMs,
            resultLength: result.length,
          },
        })

        await services.runRepo.save(state.run)
        return result
      } catch (err) {
        const durationMs = Math.round(performance.now() - startTime)
        const errMsg = err instanceof Error ? err.message : String(err)

        // Fail step + emit event
        failStep(step, errMsg)
        await services.eventBus.publish(
          stepFailed(state.run.id, step.id, errMsg),
        )

        // Record failure metric
        const record: ExecutionRecord = {
          id: randomUUID(),
          runId: state.run.id,
          stepId: step.id,
          action: tool.name,
          success: false,
          durationMs,
          result: {},
          error: errMsg,
          recordedAt: new Date(),
        }
        await services.learner.record(record)

        // Audit: tool failed
        await services.auditService.log({
          actor: state.actor,
          action: "tool.failed",
          resourceType: "AgentRun",
          resourceId: state.run.id,
          detail: { tool: tool.name, stepId: step.id, error: errMsg, durationMs },
        })

        await services.runRepo.save(state.run)
        throw err
      }
    },
  }
}

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

export function printGovernanceReport(result: GovernedResult): void {
  const { run, auditTrail, stats } = result

  console.log("\n" + "═".repeat(60))
  console.log("  GOVERNANCE REPORT")
  console.log("═".repeat(60))

  // Run summary
  console.log(`\n  Run ID:     ${run.id}`)
  console.log(`  Status:     ${run.status}`)
  console.log(`  Steps:      ${run.steps.length} tool calls`)
  console.log(`  Started:    ${run.createdAt.toISOString()}`)
  if (run.completedAt) {
    const durationSec = (run.completedAt.getTime() - run.createdAt.getTime()) / 1000
    console.log(`  Completed:  ${run.completedAt.toISOString()} (${durationSec.toFixed(1)}s)`)
  }

  // Steps timeline
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

  // Tool stats
  if (stats.size > 0) {
    console.log("\n  ── Tool Stats ──")
    for (const [tool, s] of stats) {
      console.log(
        `  ${tool}: ${s.calls} calls, avg ${s.avgMs}ms, ${s.failures} failures`,
      )
    }
  }

  // Audit trail
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
