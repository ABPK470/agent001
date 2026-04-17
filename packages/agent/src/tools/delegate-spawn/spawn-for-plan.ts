import { readFile as fsReadFile } from "node:fs/promises"
import { resolve as pathResolve } from "node:path"
import { Agent } from "../../agent.js"
import { detectPlaceholderPatterns } from "../../code-quality.js"
import type { DelegateResult } from "../../planner/pipeline.js"
import type { ExecutionEnvelope, SubagentTaskStep } from "../../planner/types.js"
import type { Tool } from "../../types.js"
import { canonicalizeEnvelope, computePlannerChildBudgetMetrics, wrapPlannerChildToolsForWriteScope } from "../delegate-paths.js"
import { CHILD_SYSTEM_PROMPT, type DelegateContext } from "../delegate.js"
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

  // Build the child's goal from the step's contract
  const goalParts: string[] = [
    `## Workspace — READ THIS FIRST\nYou are working in: ${normalizedEnvelope.workspaceRoot}\nAll file paths are relative to this directory. Use relative paths (e.g. "tmp/index.html") with read_file/write_file.\nWrite scope: ${normalizedEnvelope.allowedWriteRoots.join(", ") || normalizedEnvelope.workspaceRoot}`,
  ]

  if (normalizedEnvelope.requiredSourceArtifacts.length > 0) {
    goalParts.push(
      `## Source Files — READ THESE FIRST (MANDATORY)\nThese files ALREADY EXIST on disk, created by prior steps. You are BUILDING ON TOP of this work.\nYou MUST read each of these files with read_file BEFORE writing any code.\nDo NOT rewrite or replace these files unless they are also listed in your Target Files.\n${normalizedEnvelope.requiredSourceArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  goalParts.push(`## Objective\n${step.objective}`)

  const hasBlueprintSource = normalizedEnvelope.requiredSourceArtifacts.some(
    a => /BLUEPRINT\.md$/i.test(a),
  )
  if (hasBlueprintSource) {
    goalParts.push(
      `## BLUEPRINT CONTRACT — MANDATORY\nThe BLUEPRINT.md file in your Source Files defines function signatures AND algorithmic contracts.\nYou MUST implement EVERY case listed in each function's contract. A function named "validateMove" that lists 6 piece types means you implement ALL 6 — not 1-2 with a catch-all return.\nA function named "checkGameStatus" that lists checkmate, stalemate, and draw conditions means you implement ALL of them — not just "return 'ongoing'".\nFailing to implement all contract cases = STUB = REJECTION.`,
    )
  }

  if (step.inputContract) {
    goalParts.push(`## Input Context\n${step.inputContract}`)
  }

  if (step.acceptanceCriteria.length > 0) {
    goalParts.push(
      `## Acceptance Criteria (ALL must be met)\n${step.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    )
  }

  if (normalizedEnvelope.targetArtifacts.length > 0) {
    goalParts.push(
      `## Target Files\nYou are responsible for creating/modifying:\n${normalizedEnvelope.targetArtifacts.map(a => `- ${a}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.upstreamAcceptedArtifacts?.length ?? 0) > 0) {
    goalParts.push(
      `## Accepted Upstream Artifacts\nThese artifacts are already verified and safe to rely on:\n${normalizedEnvelope.upstreamAcceptedArtifacts!.map(a => `- ${a}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.unresolvedDependencyBlockers?.length ?? 0) > 0) {
    goalParts.push(
      `## Dependency Blockers\nDo NOT claim completion for work that depends on these unresolved blockers:\n${normalizedEnvelope.unresolvedDependencyBlockers!.map(item => `- ${item}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.requiredChecks?.length ?? 0) > 0) {
    goalParts.push(
      `## Required Checks Before Completion\nYou must run or reason through these checks before finishing:\n${normalizedEnvelope.requiredChecks!.map(item => `- ${item}`).join("\n")}`,
    )
  }

  if ((normalizedEnvelope.repairContext?.goals.length ?? 0) > 0 || (normalizedEnvelope.repairContext?.dependencyGoals.length ?? 0) > 0) {
    goalParts.push(
      `## Structured Repair Payload\nMode: ${normalizedEnvelope.repairContext?.mode ?? "initial"}\n` +
      `Owned Repair Goals:\n${(normalizedEnvelope.repairContext?.goals.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.goals.map(goal => `- [${goal.issueCode}] ${goal.summary} (${goal.repairClass}, ${goal.severity}, ${(goal.confidence * 100).toFixed(0)}%, owner=${goal.primaryOwner ?? "none"}, mode=${goal.ownershipMode}, suspects=${goal.suspectedOwners.join(", ") || "none"})`).join("\n")
        : "- none"}\n` +
      `Dependency Context Goals:\n${(normalizedEnvelope.repairContext?.dependencyGoals.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.dependencyGoals.map(goal => `- [${goal.issueCode}] ${goal.summary} (${(goal.confidence * 100).toFixed(0)}%, mode=${goal.ownershipMode}, suspects=${goal.suspectedOwners.join(", ") || "none"})`).join("\n")
        : "- none"}\n` +
      `Required Accepted Artifacts:\n${(normalizedEnvelope.repairContext?.requiredAcceptedArtifacts.length ?? 0) > 0
        ? normalizedEnvelope.repairContext!.requiredAcceptedArtifacts.map(artifact => `- ${artifact}`).join("\n")
        : "- none"}`,
    )

    if (normalizedEnvelope.repairContext?.preserveArchitecture) {
      goalParts.push(
        `## Architecture Preservation Policy\n` +
        `Preserve Architecture: yes\n` +
        `Frozen Architecture: ${normalizedEnvelope.repairContext.architectureSummary ?? "unspecified"}\n` +
        `Shared Contracts:\n${(normalizedEnvelope.repairContext.sharedContracts?.length ?? 0) > 0
          ? normalizedEnvelope.repairContext.sharedContracts!.map((contract) => `- ${contract.name}: ${contract.description}`).join("\n")
          : "- none"}\n` +
        `System Invariants:\n${(normalizedEnvelope.repairContext.invariants?.length ?? 0) > 0
          ? normalizedEnvelope.repairContext.invariants!.map((invariant) => `- ${invariant.id}: ${invariant.description}`).join("\n")
          : "- none"}\n` +
        `Repair policy: fix the verified issues inside the frozen architecture first. Do not redesign interfaces or redistribute ownership unless the evidence proves the architecture itself is broken.`,
      )
    }
  }

  goalParts.push(
    `## Step Contract\n` +
    `Step Name: ${step.name}\n` +
    `Role: ${normalizedEnvelope.role ?? "writer"}\n` +
    `Effect Class: ${normalizedEnvelope.effectClass}\n` +
    `Verification Mode: ${normalizedEnvelope.verificationMode}\n` +
    `Owned Artifacts:\n${normalizedEnvelope.targetArtifacts.map(a => `- ${a}`).join("\n") || "- none"}\n` +
    `Readable Context Artifacts:\n${normalizedEnvelope.requiredSourceArtifacts.map(a => `- ${a}`).join("\n") || "- none"}\n` +
    `Forbidden Writes:\n${(normalizedEnvelope.forbiddenArtifacts?.length ?? 0) > 0
      ? normalizedEnvelope.forbiddenArtifacts!.map(a => `- ${a}`).join("\n")
      : "- any artifact not listed under Owned Artifacts unless explicitly allowed as integration context."}`,
  )

  const goal = goalParts.join("\n\n")

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

  if (ctx.extraChildTools) {
    const extraNames = new Set(ctx.extraChildTools.map(t => t.name))
    childTools = [
      ...childTools.filter(t => !extraNames.has(t.name)),
      ...ctx.extraChildTools,
    ]
  }

  childTools = wrapPlannerChildToolsForWriteScope(childTools, normalizedEnvelope)

  const budgetMetrics = computePlannerChildBudgetMetrics(step, normalizedEnvelope)
  const maxIter = budgetMetrics.computedMaxIterations

  ctx.onChildTrace?.({
    kind: "planner-delegation-start",
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
    const childRunId = `plan-${step.name}-${Date.now()}`
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
        kind: "planner-delegation-iteration",
        stepName: step.name,
        depth: ctx.depth + 1,
        iteration: iteration + 1,
        maxIterations: maxIter,
      })
      for (const ev of pendingPlannerLlmEvents) ctx.onChildTrace?.(ev)
      pendingPlannerLlmEvents = []
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onStep: () => {
      ctx.onChildUsage?.(child.usage, child.llmCalls)
    },
    onNudge: (data) => {
      ctx.onChildTrace?.({
        kind: "nudge",
        tag: `[${step.name}] ${data.tag}`,
        message: data.message,
        iteration: data.iteration,
      })
    },
    onLlmCall: (data) => {
      if (data.phase === "request") {
        pendingPlannerLlmEvents.push({
          kind: "llm-request",
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
          kind: "llm-response",
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
      kind: "planner-delegation-end",
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
      kind: "planner-delegation-end",
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
