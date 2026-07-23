import type { EngineServices } from "@mia/agent"
import { EventType, PipelineStatus } from "@mia/agent"
import * as db from "../../../../infra/persistence/sqlite.js"
import { AuditActor } from "../../../../internal/enums/audit.js"
import { broadcast, broadcastTraceLoose } from "../../../../infra/events/broadcaster.js"

// ── Planner trace event dispatcher ───────────────────────────────

/**
 * Handle a single onPlannerTrace entry from the agent engine.
 * Routes each planner event kind to its SSE broadcast + audit log.
 */
export function handlePlannerTrace(
  entry: unknown,
  ctx: {
    runId: string
    services: EngineServices
    debugSeqRef: { value: number }
    saveTrace: (runId: string, entry: Record<string, unknown>) => void
  }
): void {
  const e = entry as Record<string, unknown>
  const { runId, services, debugSeqRef, saveTrace } = ctx

  ctx.saveTrace(runId, e)
  broadcastTraceLoose(runId, debugSeqRef.value++, e as { kind: string } & Record<string, unknown>)

  const kind = e.kind as string

  if (kind === "planner-decision" && e.shouldPlan) {
    broadcast({
      type: EventType.PlannerStarted,
      data: {
        runId,
        score: e.score,
        reason: e.reason,
        route: e.route
      }
    })
    services.auditService
      .log({
        actor: AuditActor.Agent,
        action: "planner.started",
        resourceType: "AgentRun",
        resourceId: runId,
        detail: {
          score: e.score,
          reason: e.reason,
          route: e.route
        }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  } else if (kind === "planner-pipeline-end") {
    broadcast({
      type: EventType.PlannerCompleted,
      data: { runId, status: e.status, completedSteps: e.completedSteps, totalSteps: e.totalSteps }
    })
    services.auditService
      .log({
        actor: AuditActor.Agent,
        action: e.status === PipelineStatus.Completed ? "planner.completed" : "planner.failed",
        resourceType: "AgentRun",
        resourceId: runId,
        detail: { status: e.status, completedSteps: e.completedSteps, totalSteps: e.totalSteps }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  } else if (kind === "planner-pipeline-start") {
    broadcast({
      type: EventType.PlannerPipelineStarted,
      data: { runId, attempt: e.attempt, maxRetries: e.maxRetries }
    })
  } else if (kind === "planner-validation-failed") {
    broadcast({ type: EventType.PlannerValidationFailed, data: { runId, diagnostics: e.diagnostics } })
    services.auditService
      .log({
        actor: AuditActor.Agent,
        action: "planner.validation.failed",
        resourceType: "AgentRun",
        resourceId: runId,
        detail: { diagnostics: e.diagnostics }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  } else if (kind === "planner-platform-unconfigured") {
    // Operator-only event — the user-facing answer is opaque on purpose.
    // Persist the technical detail to the run logs (visible to admins via the
    // run detail view), audit log, and the realtime stream so admins can
    // diagnose without scraping stdout. Logged at error level so it sorts
    // alongside other actionable failures.
    const subject = String(e.subject ?? "unknown")
    const remediation = String(e.remediation ?? "")
    const stepName = String(e.stepName ?? "?")
    const message = `Platform integration not configured: ${subject} (step "${stepName}"). ${remediation}`
    db.saveLog({ run_id: runId, level: "run:error", message, timestamp: new Date().toISOString() })
    broadcast({
      type: EventType.PlannerPlatformUnconfigured,
      data: { runId, stepName, subject, remediation, rawError: e.rawError }
    })
    services.auditService
      .log({
        actor: AuditActor.Agent,
        action: "planner.platform.unconfigured",
        resourceType: "AgentRun",
        resourceId: runId,
        detail: { stepName, subject, remediation, rawError: e.rawError }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
    // eslint-disable-next-line no-console
    console.error(`[run ${runId}] ${message}`)
  } else if (kind === "planner-validation-remediated") {
    broadcast({
      type: EventType.PlannerValidationRemediated,
      data: { runId, diagnostics: e.diagnostics }
    })
    services.auditService
      .log({
        actor: AuditActor.Agent,
        action: "planner.validation.remediated",
        resourceType: "AgentRun",
        resourceId: runId,
        detail: { diagnostics: e.diagnostics }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  } else if (kind === "planner-runtime-compiled") {
    broadcast({
      type: EventType.PlannerRuntimeCompiled,
      data: {
        runId,
        executionSteps: e.executionSteps,
        ownershipArtifacts: e.ownershipArtifacts,
        runtimeEntities: e.runtimeEntities
      }
    })
    services.auditService
      .log({
        actor: AuditActor.Agent,
        action: "planner.runtime.compiled",
        resourceType: "AgentRun",
        resourceId: runId,
        detail: {
          executionSteps: e.executionSteps,
          ownershipArtifacts: e.ownershipArtifacts,
          runtimeEntities: e.runtimeEntities
        }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  } else if (kind === "planner-step-start") {
    broadcast({
      type: EventType.PlannerStepStarted,
      data: { runId, stepName: e.stepName, stepType: e.stepType }
    })
  } else if (kind === "planner-step-end") {
    broadcast({
      type: EventType.PlannerStepCompleted,
      data: {
        runId,
        stepName: e.stepName,
        status: e.status,
        executionState: e.executionState,
        acceptanceState: e.acceptanceState,
        durationMs: e.durationMs,
        error: e.error,
        validationCode: e.validationCode,
        producedArtifacts: e.producedArtifacts,
        verificationAttempts: e.verificationAttempts,
        reconciliation: e.reconciliation
      }
    })
  } else if (kind === "planner-step-transition") {
    broadcast({
      type: EventType.PlannerStepTransition,
      data: {
        runId,
        attempt: e.attempt,
        stepName: e.stepName,
        phase: e.phase,
        state: e.state,
        timestamp: e.timestamp
      }
    })
  } else if (kind === "planner-delegation-start") {
    broadcast({
      type: EventType.PlannerDelegationStarted,
      data: { runId, stepName: e.stepName, depth: e.depth, goal: e.goal, tools: e.tools }
    })
  } else if (kind === "planner-delegation-iteration") {
    broadcast({
      type: EventType.PlannerDelegationIteration,
      data: {
        runId,
        stepName: e.stepName,
        depth: e.depth,
        iteration: e.iteration,
        maxIterations: e.maxIterations,
        toolNames: e.toolNames,
        content: e.content,
      }
    })
  } else if (kind === "planner-delegation-end") {
    broadcast({
      type: EventType.PlannerDelegationEnded,
      data: {
        runId,
        stepName: e.stepName,
        depth: e.depth,
        status: e.status,
        answer: e.answer,
        error: e.error
      }
    })
  } else if (kind === "planner-verification") {
    broadcast({
      type: EventType.PlannerVerification,
      data: {
        runId,
        overall: e.overall,
        confidence: e.confidence,
        verifierRound: e.verifierRound,
        systemChecks: e.systemChecks,
        steps: e.steps
      }
    })
    services.auditService
      .log({
        actor: AuditActor.Agent,
        action: "planner.verified",
        resourceType: "AgentRun",
        resourceId: runId,
        detail: { overall: e.overall, confidence: e.confidence, steps: e.steps }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  } else if (kind === "planner-verification-followup") {
    broadcast({
      type: EventType.PlannerVerificationFollowup,
      data: { runId, requestedSteps: e.requestedSteps, reasons: e.reasons }
    })
  } else if (kind === "planner-issue-timeline") {
    broadcast({
      type: EventType.PlannerIssueTimeline,
      data: { runId, attempt: e.attempt, verifierRound: e.verifierRound, issues: e.issues }
    })
  } else if (kind === "planner-repair-plan") {
    broadcast({
      type: EventType.PlannerRepairPlan,
      data: { runId, attempt: e.attempt, epoch: e.epoch, rerunOrder: e.rerunOrder, tasks: e.tasks }
    })
    services.auditService
      .log({
        actor: AuditActor.Agent,
        action: "planner.repair.plan",
        resourceType: "AgentRun",
        resourceId: runId,
        detail: { attempt: e.attempt, epoch: e.epoch, rerunOrder: e.rerunOrder, tasks: e.tasks }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  }

  // Forward delegation + LLM debug events
  if (
    kind === "planner-delegation-start" ||
    kind === "planner-delegation-iteration" ||
    kind === "planner-delegation-end"
  ) {
    // already broadcast above
  } else if (kind === "llm-request" || kind === "llm-response" || kind === "nudge") {
    broadcastTraceLoose(runId, debugSeqRef.value++, e as { kind: string } & Record<string, unknown>)
  }
  void saveTrace // already called at top — keep TypeScript happy
}
