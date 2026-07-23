import { readFile as fsReadFile } from "node:fs/promises"
import { resolve as pathResolve } from "node:path"
import { detectPlaceholderPatterns } from "../../core/govern-tools.js"
import type { DelegateResult, ExecutionEnvelope, SubagentTaskStep } from "../../core/plan.js"
import type { Tool } from "../../domain/types/agent-types.js"
import {
  canonicalizeEnvelope,
  computePlannerChildBudgetMetrics,
  wrapPlannerChildToolsForWriteScope
} from "../delegate-paths.js"
import { CHILD_SYSTEM_PROMPT, type DelegateContext } from "../delegate/index.js"
import { buildPlanChildGoal } from "./build-goal.js"
import { spawnChild, type ChildContract } from "./spawn.js"

/**
 * Spawn a child agent for a planner-generated subagent_task step.
 *
 * Thin adapter over the shared spawn kernel: builds a `ChildContract` from
 * the plan step + execution envelope (rich goal prompt, scoped tools,
 * adaptive iteration budget, write-scope wrapping, completion validator),
 * then hands it to `spawnChild`.
 */
export async function spawnChildForPlan(
  ctx: DelegateContext,
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope
): Promise<DelegateResult> {
  const normalizedEnvelope = canonicalizeEnvelope(envelope)
  const goal = buildPlanChildGoal(step, normalizedEnvelope)

  // Filter tools based on the envelope's allowedTools / requiredToolCapabilities
  let childTools: Tool[]
  const allowedToolNames = new Set([...normalizedEnvelope.allowedTools, ...step.requiredToolCapabilities])

  if (allowedToolNames.size > 0 && normalizedEnvelope.effectClass !== "readonly") {
    for (const essential of [
      "read_file",
      "append_file",
      "replace_in_file",
      "list_directory",
      "run_command"
    ]) {
      allowedToolNames.add(essential)
    }
  }

  if (allowedToolNames.size > 0) {
    childTools = ctx.availableTools.filter((t) => allowedToolNames.has(t.name))
  } else {
    childTools = [...ctx.availableTools]
  }

  // Per-child run id — used to attribute bus messages and queue slots
  // to the actual publisher rather than the parent.
  const childRunId = `plan-${step.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const childAgentName = `Planner:${step.name}`

  // Inject extra tools — per-child factory takes priority over a flat
  // `extraChildTools` list (Phase B.3).
  const builtPerChild = ctx.buildChildTools ? ctx.buildChildTools(childRunId, childAgentName) : []
  const builtPerChildNames = new Set(builtPerChild.map((t) => t.name))
  if (ctx.extraChildTools) {
    const extraNames = new Set(ctx.extraChildTools.map((t) => t.name))
    childTools = [
      ...childTools.filter((t) => !extraNames.has(t.name) && !builtPerChildNames.has(t.name)),
      ...ctx.extraChildTools.filter((t) => !builtPerChildNames.has(t.name)),
      ...builtPerChild
    ]
  } else if (builtPerChild.length > 0) {
    childTools = [...childTools.filter((t) => !builtPerChildNames.has(t.name)), ...builtPerChild]
  }

  childTools = wrapPlannerChildToolsForWriteScope(childTools, normalizedEnvelope)

  const budgetMetrics = computePlannerChildBudgetMetrics(step, normalizedEnvelope)
  const maxIter = budgetMetrics.computedMaxIterations

  // Build completion validator for code quality gate
  const targetArtifacts = normalizedEnvelope.targetArtifacts
  const wsRoot = normalizedEnvelope.workspaceRoot
  const completionValidator =
    targetArtifacts.length > 0
      ? async (): Promise<string | null> => {
          const codeArtifacts = targetArtifacts.filter((a) =>
            /\.(js|jsx|ts|tsx|py|rb|java|cs|go|rs)$/i.test(a)
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
            } catch (err: unknown) { console.error("[mia]", err) }
          }

          if (allIssues.length > 0) {
            return (
              `COMPLETION CHECK FAILED — your code still contains stub/placeholder functions:\n` +
              allIssues.map((i) => `  - ${i}`).join("\n") +
              "\n\n" +
              `You MUST fix these before finishing. For EACH stub function:\n` +
              `1. The function name tells you what it should do — implement the REAL algorithm\n` +
              `2. Replace the stub body (return true/false/[]/{}/ or comment-only) with working logic\n` +
              `3. A function called "validateInput" must enforce all required validation rules\n` +
              `4. A function called "computeResult" must execute the full required business logic\n` +
              `Do NOT provide a final answer until ALL stubs are replaced with real code.`
            )
          }
          return null
        }
      : undefined

  const contract: ChildContract = {
    goal,
    childRunId,
    childAgentName,
    tools: childTools,
    maxIterations: maxIter,
    // If the parent resolved system prompt is available (contains DB knowledge, schema context,
    // tool rules, memory etc.) prepend it so the child is not "blind" — otherwise it has no
    // knowledge of the database, schemas, or domain-specific tool usage rules.
    systemPrompt: ctx.parentSystemPrompt
      ? `${ctx.parentSystemPrompt}\n\n---\n\n${CHILD_SYSTEM_PROMPT}`
      : CHILD_SYSTEM_PROMPT,
    completionValidator,
    deferRecoveryHintsUntilCompletionAttempt: true,
    trace: {
      kind: "planner",
      stepName: step.name,
      goal: step.objective,
      budget: budgetMetrics,
      envelope: {
        workspaceRoot: normalizedEnvelope.workspaceRoot,
        effectClass: normalizedEnvelope.effectClass,
        verificationMode: normalizedEnvelope.verificationMode,
        targetArtifacts: normalizedEnvelope.targetArtifacts,
        upstreamAcceptedArtifacts: normalizedEnvelope.upstreamAcceptedArtifacts,
        unresolvedDependencyBlockers: normalizedEnvelope.unresolvedDependencyBlockers,
        repairContext: normalizedEnvelope.repairContext
      }
    }
  }

  return spawnChild(ctx, contract)
}
