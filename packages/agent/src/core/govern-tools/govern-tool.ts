/**
 * Tool-governance wrapper. Extracted from governance.ts.
 *
 * @module
 */

import { randomUUID } from "node:crypto"
import { stripRuntimeToolArgs } from "@mia/shared-types"
import type { ExecutableTool } from "../../domain/models/agent-types.js"
import {
  ApprovalRequiredError,
  type ExecutionRecord,
  PolicyViolationError,
  StepStatus,
  blockStep,
  completeStep,
  failStep,
  startStep,
  stepCompleted,
  stepFailed,
  stepStarted
} from "../../domain/index.js"
import type { HostedPolicyContext } from "../../domain/services/policy-context.js"
import { normalizeToolExecutionOutput } from "../../tools/index.js"
import { TOOL_RETRY_POLICY, type ToolRetryPolicy, withToolRetry } from "../recover.js"
import { type EngineServices, type RunState, createToolStep } from "./types.js"

// ── Tool governance options ──────────────────────────────────────

/** Default timeout for tool execution: 60 seconds. */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000

export interface GovernToolOptions {
  /** Retry policy for transient tool failures. */
  retryPolicy?: ToolRetryPolicy
  /** Timeout in ms for tool execution (default: 60s). */
  timeoutMs?: number
  /** AbortSignal — when fired, tool execution terminates immediately. */
  signal?: AbortSignal
  /** Per-run policy facts for selector evaluation. */
  policyContext?: HostedPolicyContext | null
}

// ── Wrap a tool with governance ──────────────────────────────────

export function governTool(
  tool: ExecutableTool,
  services: EngineServices,
  state: RunState,
  options?: GovernToolOptions
): ExecutableTool {
  const retryPolicy = options?.retryPolicy ?? TOOL_RETRY_POLICY
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS

  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,

    async execute(args: Record<string, unknown>): Promise<string> {
      const persistedArgs = stripRuntimeToolArgs(args)
      const step = createToolStep(tool.name, persistedArgs, state)
      state.run.steps.push(step)

      // 1. Policy check — can this tool run?
      try {
        const policyResult = await services.policyEvaluator.evaluatePreStep(
          state.run,
          step,
          options?.policyContext ?? null
        )
        if (policyResult !== null) {
          const policyName = policyResult.startsWith("Policy '")
            ? (policyResult.match(/^Policy '([^']+)'/)?.[1] ?? "require_approval")
            : "require_approval"
          startStep(step)
          blockStep(step, policyResult)
          await services.auditService.log({
            actor: state.actor,
            action: "tool.blocked",
            resourceType: "AgentRun",
            resourceId: state.run.id,
            detail: { tool: tool.name, reason: policyResult, stepId: step.id }
          })
          await services.runRepo.save(state.run)
          throw new ApprovalRequiredError(
            state.run.id,
            step.id,
            tool.name,
            persistedArgs,
            policyResult,
            policyName
          )
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
            detail: { tool: tool.name, reason: err.message, stepId: step.id }
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
        detail: { tool: tool.name, args: persistedArgs, stepId: step.id }
      })

      // 4. Execute the tool — with timeout + abort + retry on transient errors
      const startTime = performance.now()
      const abortSignal = options?.signal
      try {
        const retryResult = await withToolRetry(
          async () => {
            // Race: tool execution vs timeout vs abort
            const racers: Promise<string>[] = [
              tool.execute(args).then((value) => normalizeToolExecutionOutput(value).result),
              ...(timeoutMs > 0
                ? [
                    new Promise<never>((_, reject) => {
                      const id = setTimeout(
                        () => reject(new Error(`Tool "${tool.name}" timed out after ${timeoutMs}ms`)),
                        timeoutMs
                      )
                      // If tool finishes first, prevent dangling timer
                      if (typeof id === "object" && "unref" in id) (id as NodeJS.Timeout).unref()
                    })
                  ]
                : [])
            ]

            // If we have an abort signal, add it to the race
            if (abortSignal) {
              racers.push(
                new Promise<never>((_, reject) => {
                  if (abortSignal.aborted) {
                    reject(new Error(`Tool "${tool.name}" cancelled`))
                    return
                  }
                  const onAbort = () => reject(new Error(`Tool "${tool.name}" cancelled`))
                  abortSignal.addEventListener("abort", onAbort, { once: true })
                })
              )
            }

            return Promise.race(racers)
          },
          retryPolicy,
          abortSignal
        )

        const durationMs = Math.round(performance.now() - startTime)

        if (!retryResult.success) {
          // All retries exhausted — fail the step
          const errMsg = retryResult.lastError?.message ?? "Tool execution failed"
          failStep(step, errMsg)
          await services.eventBus.publish(stepFailed(state.run.id, step.id, errMsg))

          const record: ExecutionRecord = {
            id: randomUUID(),
            runId: state.run.id,
            stepId: step.id,
            action: tool.name,
            success: false,
            durationMs,
            result: {},
            error: errMsg,
            recordedAt: new Date()
          }
          await services.learner.record(record)

          await services.auditService.log({
            actor: state.actor,
            action: "tool.failed",
            resourceType: "AgentRun",
            resourceId: state.run.id,
            detail: {
              tool: tool.name,
              stepId: step.id,
              error: errMsg,
              durationMs,
              attempts: retryResult.attempts,
              retried: retryResult.attempts > 1
            }
          })

          await services.runRepo.save(state.run)
          throw retryResult.lastError ?? new Error(errMsg)
        }

        const result = retryResult.value!

        // 5. Complete step
        completeStep(step, { result, durationMs, attempts: retryResult.attempts })
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
          recordedAt: new Date()
        }
        await services.learner.record(record)

        // 7. Audit: tool completed (include retry info if retried)
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
            ...(retryResult.attempts > 1 ? { attempts: retryResult.attempts, retried: true } : {})
          }
        })

        await services.runRepo.save(state.run)
        return result
      } catch (err) {
        const durationMs = Math.round(performance.now() - startTime)
        const errMsg = err instanceof Error ? err.message : String(err)

        // Only fail step if not already failed by retry handler above
        if (step.status !== StepStatus.Failed) {
          failStep(step, errMsg)
          await services.eventBus.publish(stepFailed(state.run.id, step.id, errMsg))

          const record: ExecutionRecord = {
            id: randomUUID(),
            runId: state.run.id,
            stepId: step.id,
            action: tool.name,
            success: false,
            durationMs,
            result: {},
            error: errMsg,
            recordedAt: new Date()
          }
          await services.learner.record(record)

          await services.auditService.log({
            actor: state.actor,
            action: "tool.failed",
            resourceType: "AgentRun",
            resourceId: state.run.id,
            detail: { tool: tool.name, stepId: step.id, error: errMsg, durationMs }
          })

          await services.runRepo.save(state.run)
        }

        throw err
      }
    }
  }
}
