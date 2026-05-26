import { readFile as fsReadFile } from "node:fs/promises"
import { resolve as pathResolve } from "node:path"
import { detectPlaceholderPatterns } from "../../application/core/governance.js"
import type { DelegateResult, ExecutionEnvelope, SubagentTaskStep } from "../../application/core/planner.js"
import { Agent } from "../../application/shell/agent.js"
import { LLMCallPhase } from "../../domain/enums/llm.js"
import { DelegationSpanEventKind, DelegationTraceKind } from "../../domain/enums/planner-trace.js"
import type { Tool } from "../../types.js"
import { canonicalizeEnvelope, computePlannerChildBudgetMetrics, wrapPlannerChildToolsForWriteScope } from "../delegate-paths.js"
import { CHILD_SYSTEM_PROMPT, type DelegateContext } from "../delegate/index.js"
import { buildPlanChildGoal } from "./build-goal.js"
import { buildChildExecutionResult } from "./helpers.js"

/**
 * Spawn a child agent for a planner-generated subagent_task step.
 *
 * Unlike ad-hoc delegation, this uses the ExecutionEnvelope to:
 *   - Build a rich prompt with objective, acceptance criteria, and context
 *   - Scope the child's tool access to requiredToolCapabilities
 *   - Pass workspace and artifact constraints
 */
export async function spawnChildForPlan(
  ctx: DelegateContext,
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope,
): Promise<DelegateResult> {
  const normalizedEnvelope = canonicalizeEnvelope(envelope)
  const goal = buildPlanChildGoal(step, normalizedEnvelope)


  // Filter tools based on the envelope's allowedTools / requiredToolCapabilities
  let childTools: Tool[]
  const allowedToolNames = new Set([
    ...normalizedEnvelope.allowedTools,
    ...step.requiredToolCapabilities,
  ])

  if (allowedToolNames.size > 0 && normalizedEnvelope.effectClass !== "readonly") {
    for (const essential of ["read_file", "append_file", "replace_in_file", "list_directory", "browser_check", "run_command"]) {
      allowedToolNames.add(essential)
    }
  }

  if (allowedToolNames.size > 0) {
    childTools = ctx.availableTools.filter(t =>
      allowedToolNames.has(t.name) && t.name !== "delegate" && t.name !== "delegate_parallel",
    )
  } else {
    childTools = ctx.availableTools.filter(t =>
      t.name !== "delegate" && t.name !== "delegate_parallel",
    )
  }

  // Per-child run id — used to attribute bus messages and queue slots
  // to the actual publisher rather than the parent. See spawn-child.ts
  // for the same pattern.
  const childRunId = `plan-${step.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const childAgentName = `Planner:${step.name}`

  // Inject extra tools — per-child factory takes priority over a flat
  // `extraChildTools` list (Phase B.3).
  const builtPerChild = ctx.buildChildTools ? ctx.buildChildTools(childRunId, childAgentName) : []
  const builtPerChildNames = new Set(builtPerChild.map(t => t.name))
  if (ctx.extraChildTools) {
    const extraNames = new Set(ctx.extraChildTools.map(t => t.name))
    childTools = [
      ...childTools.filter(t => !extraNames.has(t.name) && !builtPerChildNames.has(t.name)),
      ...ctx.extraChildTools.filter(t => !builtPerChildNames.has(t.name)),
      ...builtPerChild,
    ]
  } else if (builtPerChild.length > 0) {
    childTools = [
      ...childTools.filter(t => !builtPerChildNames.has(t.name)),
      ...builtPerChild,
    ]
  }

  childTools = wrapPlannerChildToolsForWriteScope(childTools, normalizedEnvelope)

  const budgetMetrics = computePlannerChildBudgetMetrics(step, normalizedEnvelope)
  const maxIter = budgetMetrics.computedMaxIterations

  ctx.onChildTrace?.({
    kind: DelegationTraceKind.PlannerStart,
    goal: step.objective,
    stepName: step.name,
    depth: ctx.depth + 1,
    tools: childTools.map(t => t.name),
    budget: budgetMetrics,
    envelope: {
      workspaceRoot: normalizedEnvelope.workspaceRoot,
      effectClass: normalizedEnvelope.effectClass,
      verificationMode: normalizedEnvelope.verificationMode,
      targetArtifacts: normalizedEnvelope.targetArtifacts,
      upstreamAcceptedArtifacts: normalizedEnvelope.upstreamAcceptedArtifacts,
      unresolvedDependencyBlockers: normalizedEnvelope.unresolvedDependencyBlockers,
      repairContext: normalizedEnvelope.repairContext,
    },
  })

  let releaseSlot: (() => void) | undefined
  if (ctx.acquireSlot) {
    // Reuse the same childRunId we generated above so queue + bus see one entity.
    releaseSlot = await ctx.acquireSlot(childRunId)
  }

  let pendingPlannerLlmEvents: Record<string, unknown>[] = []

  // Build completion validator for code quality gate
  const targetArtifacts = normalizedEnvelope.targetArtifacts
  const wsRoot = normalizedEnvelope.workspaceRoot
  const completionValidator = targetArtifacts.length > 0 ? async (): Promise<string | null> => {
    const codeArtifacts = targetArtifacts.filter(
      a => /\.(js|jsx|ts|tsx|py|rb|java|cs|go|rs)$/i.test(a),
    )
    if (codeArtifacts.length === 0) return null

    const allIssues: string[] = []
    for (const artifact of codeArtifacts) {
      const fullPath = pathResolve(wsRoot, artifact)
      try {
        const content = await fsReadFile(fullPath, "utf-8")
        const findings = detectPlaceholderPatterns(content)
        for (const f of findings) {
          allIssues.push(`${artifact}: ${f}`)
        }
      } catch { /* file not created yet or unreadable */ }
    }

    if (allIssues.length > 0) {
      return (
        `COMPLETION CHECK FAILED — your code still contains stub/placeholder functions:\n` +
        allIssues.map(i => `  - ${i}`).join("\n") + "\n\n" +
        `You MUST fix these before finishing. For EACH stub function:\n` +
        `1. The function name tells you what it should do — implement the REAL algorithm\n` +
        `2. Replace the stub body (return true/false/[]/{}/ or comment-only) with working logic\n` +
        `3. A function called "validateInput" must enforce all required validation rules\n` +
        `4. A function called "computeResult" must execute the full required business logic\n` +
        `Do NOT provide a final answer until ALL stubs are replaced with real code.`
      )
    }
    return null
  } : undefined

  const child = new Agent(ctx.llm, childTools, {
    maxIterations: maxIter,
    // If the parent resolved system prompt is available (contains DB knowledge, schema context,
    // tool rules, memory etc.) prepend it so the child is not "blind" — otherwise it has no
    // knowledge of the database, schemas, or domain-specific tool usage rules.
    systemPrompt: ctx.parentSystemPrompt
      ? `${ctx.parentSystemPrompt}\n\n---\n\n${CHILD_SYSTEM_PROMPT}`
      : CHILD_SYSTEM_PROMPT,
    verbose: false,
    signal: ctx.signal,
    deferRecoveryHintsUntilCompletionAttempt: true,
    completionValidator,
    onThinking: (_content, _toolCalls, iteration) => {
      ctx.onChildTrace?.({
        kind: DelegationTraceKind.PlannerIteration,
        stepName: step.name,
        depth: ctx.depth + 1,
        iteration: iteration + 1,
        maxIterations: maxIter,
      })
      for (const ev of pendingPlannerLlmEvents) ctx.onChildTrace?.(ev)
      pendingPlannerLlmEvents = []
      ctx.onChildUsage?.(child.usage, child.llmCalls)
      // Phase B.3: notify the orchestrator on every iteration so it can
      // auto-publish a Status to the bus on this child's behalf.
      ctx.onChildIteration?.({
        childRunId,
        childAgentName,
        iteration: iteration + 1,
        maxIterations: maxIter,
        content: _content ? _content.slice(0, 200) : null,
        toolNames: _toolCalls.map((c) => c.name),
      })
    },
    onStep: () => {
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onNudge: (data) => {
      ctx.onChildTrace?.({
        kind: DelegationSpanEventKind.Nudge,
        tag: `[${step.name}] ${data.tag}`,
        message: data.message,
        iteration: data.iteration,
      })
    },
    onLlmCall: (data) => {
      if (data.phase === LLMCallPhase.Request) {
        pendingPlannerLlmEvents.push({
          kind: DelegationSpanEventKind.LlmRequest,
          iteration: data.iteration,
          messageCount: data.messages.length,
          toolCount: data.tools.length,
          messages: data.messages.map(m => ({
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls?.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) ?? [],
            toolCallId: m.toolCallId ?? null,
          })),
        })
      } else {
        pendingPlannerLlmEvents.push({
          kind: DelegationSpanEventKind.LlmResponse,
          iteration: data.iteration,
          durationMs: data.durationMs,
          content: data.response.content,
          toolCalls: data.response.toolCalls?.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) ?? [],
          usage: data.response.usage ?? null,
        })
      }
    },
  })

  try {
    const answer = await child.run(goal)
    const hitLimit = answer.startsWith("Agent stopped after")

    ctx.onChildUsage?.(child.usage, child.llmCalls)
    ctx.onChildTrace?.({
      kind: DelegationTraceKind.PlannerEnd,
      stepName: step.name,
      depth: ctx.depth + 1,
      status: hitLimit ? "error" : "done",
      answer: answer.slice(0, 500),
    })

    if (hitLimit) {
      const execution = buildChildExecutionResult(answer, child.allToolCalls)
      return {
        output: `⚠ DELEGATION INCOMPLETE — child agent for step "${step.name}" used all ${maxIter} iterations without finishing.\nChild's last output: ${answer}`,
        toolCalls: child.allToolCalls,
        execution,
      }
    }

    return {
      output: answer,
      toolCalls: child.allToolCalls,
      execution: buildChildExecutionResult(answer, child.allToolCalls),
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    ctx.onChildTrace?.({
      kind: DelegationTraceKind.PlannerEnd,
      stepName: step.name,
      depth: ctx.depth + 1,
      status: "error",
      error: errMsg,
    })
    const output = `Delegation failed: ${errMsg}`
    return {
      output,
      toolCalls: child.allToolCalls,
      execution: buildChildExecutionResult(output, child.allToolCalls),
    }
  } finally {
    releaseSlot?.()
  }
}
