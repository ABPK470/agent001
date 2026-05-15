import type { EngineServices } from "@mia/agent"
import { EventType } from "@mia/agent"
import type { TraceEntry } from "@mia/shared-types"
import * as db from "../db/index.js"
import { AuditActor } from "../enums/audit.js"
import { broadcast, broadcastTrace } from "../event-broadcaster.js"

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
  },
): void {
  const e = entry as Record<string, unknown>
  const { runId, services, debugSeqRef, saveTrace } = ctx

  ctx.saveTrace(runId, e)
  broadcastTrace(runId, debugSeqRef.value++, entry as TraceEntry)

  const kind = e.kind as string

  if (kind === "planner-decision" && e.shouldPlan) {
    broadcast({ type: EventType.PlannerStarted, data: { runId, score: e.score, reason: e.reason, route: e.route, coherenceNeed: e.coherenceNeed, coordinationNeed: e.coordinationNeed } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.started", resourceType: "AgentRun", resourceId: runId, detail: { score: e.score, reason: e.reason, route: e.route, coherenceNeed: e.coherenceNeed, coordinationNeed: e.coordinationNeed } }).catch(() => {})
  } else if (kind === "planner-coherent-bootstrap") {
    broadcast({ type: EventType.PlannerCoherentBootstrap, data: { runId, artifactCount: e.artifactCount, decompositionStrategy: e.decompositionStrategy, decompositionReasons: e.decompositionReasons, sharedContracts: e.sharedContracts, invariants: e.invariants } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.bootstrap", resourceType: "AgentRun", resourceId: runId, detail: { artifactCount: e.artifactCount, decompositionStrategy: e.decompositionStrategy, decompositionReasons: e.decompositionReasons, sharedContracts: e.sharedContracts, invariants: e.invariants } }).catch(() => {})
  } else if (kind === "planner-architecture-state") {
    broadcast({ type: EventType.PlannerArchitectureState, data: { runId, lane: e.lane, status: e.status, reason: e.reason, architecture: e.architecture } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.architecture.state", resourceType: "AgentRun", resourceId: runId, detail: { lane: e.lane, status: e.status, reason: e.reason, architecture: e.architecture } }).catch(() => {})
  } else if (kind === "planner-pipeline-end") {
    broadcast({ type: EventType.PlannerCompleted, data: { runId, status: e.status, completedSteps: e.completedSteps, totalSteps: e.totalSteps } })
    services.auditService.log({ actor: AuditActor.Agent, action: e.status === "completed" ? "planner.completed" : "planner.failed", resourceType: "AgentRun", resourceId: runId, detail: { status: e.status, completedSteps: e.completedSteps, totalSteps: e.totalSteps } }).catch(() => {})
  } else if (kind === "planner-pipeline-start") {
    broadcast({ type: EventType.PlannerPipelineStarted, data: { runId, attempt: e.attempt, maxRetries: e.maxRetries } })
  } else if (kind === "planner-validation-failed") {
    broadcast({ type: EventType.PlannerValidationFailed, data: { runId, diagnostics: e.diagnostics } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.validation.failed", resourceType: "AgentRun", resourceId: runId, detail: { diagnostics: e.diagnostics } }).catch(() => {})
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
    broadcast({ type: EventType.PlannerPlatformUnconfigured, data: { runId, stepName, subject, remediation, rawError: e.rawError } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.platform.unconfigured", resourceType: "AgentRun", resourceId: runId, detail: { stepName, subject, remediation, rawError: e.rawError } }).catch(() => {})
    // eslint-disable-next-line no-console
    console.error(`[run ${runId}] ${message}`)
  } else if (kind === "planner-validation-remediated") {
    broadcast({ type: EventType.PlannerValidationRemediated, data: { runId, diagnostics: e.diagnostics } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.validation.remediated", resourceType: "AgentRun", resourceId: runId, detail: { diagnostics: e.diagnostics } }).catch(() => {})
  } else if (kind === "planner-runtime-compiled") {
    broadcast({ type: EventType.PlannerRuntimeCompiled, data: { runId, executionSteps: e.executionSteps, ownershipArtifacts: e.ownershipArtifacts, runtimeEntities: e.runtimeEntities } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.runtime.compiled", resourceType: "AgentRun", resourceId: runId, detail: { executionSteps: e.executionSteps, ownershipArtifacts: e.ownershipArtifacts, runtimeEntities: e.runtimeEntities } }).catch(() => {})
  } else if (kind === "coherent-generation-start") {
    broadcast({ type: EventType.PlannerCoherentStarted, data: { runId, route: e.route } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.started", resourceType: "AgentRun", resourceId: runId, detail: { route: e.route } }).catch(() => {})
  } else if (kind === "coherent-generation-bundle") {
    broadcast({ type: EventType.PlannerCoherentBundle, data: { runId, artifactCount: e.artifactCount, artifacts: e.artifacts, sharedContracts: e.sharedContracts, invariants: e.invariants } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.bundle", resourceType: "AgentRun", resourceId: runId, detail: { artifactCount: e.artifactCount, artifacts: e.artifacts, sharedContracts: e.sharedContracts, invariants: e.invariants } }).catch(() => {})
  } else if (kind === "coherent-generation-materialized") {
    broadcast({ type: EventType.PlannerCoherentMaterialized, data: { runId, artifactCount: e.artifactCount, artifacts: e.artifacts, readBackArtifacts: e.readBackArtifacts } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.materialized", resourceType: "AgentRun", resourceId: runId, detail: { artifactCount: e.artifactCount, artifacts: e.artifacts, readBackArtifacts: e.readBackArtifacts } }).catch(() => {})
  } else if (kind === "coherent-generation-verified") {
    broadcast({ type: EventType.PlannerCoherentVerified, data: { runId, overall: e.overall, confidence: e.confidence, issueCount: e.issueCount, systemCheckCount: e.systemCheckCount, affectedArtifacts: e.affectedArtifacts } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.verified", resourceType: "AgentRun", resourceId: runId, detail: { overall: e.overall, confidence: e.confidence, issueCount: e.issueCount, systemCheckCount: e.systemCheckCount, affectedArtifacts: e.affectedArtifacts } }).catch(() => {})
  } else if (kind === "coherent-generation-repair-needed") {
    broadcast({ type: EventType.PlannerCoherentRepairRequired, data: { runId, repairAttempt: e.repairAttempt, issueCount: e.issueCount, issues: e.issues, affectedArtifacts: e.affectedArtifacts } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.repair.required", resourceType: "AgentRun", resourceId: runId, detail: { repairAttempt: e.repairAttempt, issueCount: e.issueCount, issues: e.issues, affectedArtifacts: e.affectedArtifacts } }).catch(() => {})
  } else if (kind === "coherent-generation-escalated") {
    broadcast({ type: EventType.PlannerCoherentRepairEscalated, data: { runId, target: e.target, issueCount: e.issueCount, reason: e.reason } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.repair.escalated", resourceType: "AgentRun", resourceId: runId, detail: { target: e.target, issueCount: e.issueCount, reason: e.reason } }).catch(() => {})
  } else if (kind === "coherent-generation-handoff") {
    broadcast({ type: EventType.PlannerCoherentHandoff, data: { runId, artifactCount: e.artifactCount, verificationRoute: e.verificationRoute } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.handoff", resourceType: "AgentRun", resourceId: runId, detail: { artifactCount: e.artifactCount, verificationRoute: e.verificationRoute } }).catch(() => {})
  } else if (kind === "coherent-generation-failed") {
    broadcast({ type: EventType.PlannerCoherentFailed, data: { runId, stage: e.stage, diagnostics: e.diagnostics } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.coherent.failed", resourceType: "AgentRun", resourceId: runId, detail: { stage: e.stage, diagnostics: e.diagnostics } }).catch(() => {})
  } else if (kind === "planner-step-start") {
    broadcast({ type: EventType.PlannerStepStarted, data: { runId, stepName: e.stepName, stepType: e.stepType } })
  } else if (kind === "planner-step-end") {
    broadcast({ type: EventType.PlannerStepCompleted, data: { runId, stepName: e.stepName, status: e.status, executionState: e.executionState, acceptanceState: e.acceptanceState, durationMs: e.durationMs, error: e.error, validationCode: e.validationCode, producedArtifacts: e.producedArtifacts, verificationAttempts: e.verificationAttempts, reconciliation: e.reconciliation } })
  } else if (kind === "planner-step-transition") {
    broadcast({ type: EventType.PlannerStepTransition, data: { runId, attempt: e.attempt, stepName: e.stepName, phase: e.phase, state: e.state, timestamp: e.timestamp } })
  } else if (kind === "planner-delegation-start") {
    broadcast({ type: EventType.PlannerDelegationStarted, data: { runId, stepName: e.stepName, depth: e.depth, goal: e.goal, tools: e.tools } })
  } else if (kind === "planner-delegation-iteration") {
    broadcast({ type: EventType.PlannerDelegationIteration, data: { runId, stepName: e.stepName, depth: e.depth, iteration: e.iteration, maxIterations: e.maxIterations } })
  } else if (kind === "planner-delegation-end") {
    broadcast({ type: EventType.PlannerDelegationEnded, data: { runId, stepName: e.stepName, depth: e.depth, status: e.status, answer: e.answer, error: e.error } })
  } else if (kind === "planner-verification") {
    broadcast({ type: EventType.PlannerVerification, data: { runId, overall: e.overall, confidence: e.confidence, verifierRound: e.verifierRound, systemChecks: e.systemChecks, steps: e.steps } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.verified", resourceType: "AgentRun", resourceId: runId, detail: { overall: e.overall, confidence: e.confidence, steps: e.steps } }).catch(() => {})
  } else if (kind === "planner-verification-followup") {
    broadcast({ type: EventType.PlannerVerificationFollowup, data: { runId, requestedSteps: e.requestedSteps, reasons: e.reasons } })
  } else if (kind === "planner-issue-timeline") {
    broadcast({ type: EventType.PlannerIssueTimeline, data: { runId, attempt: e.attempt, verifierRound: e.verifierRound, issues: e.issues } })
  } else if (kind === "planner-repair-plan") {
    broadcast({ type: EventType.PlannerRepairPlan, data: { runId, attempt: e.attempt, epoch: e.epoch, rerunOrder: e.rerunOrder, tasks: e.tasks } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.repair.plan", resourceType: "AgentRun", resourceId: runId, detail: { attempt: e.attempt, epoch: e.epoch, rerunOrder: e.rerunOrder, tasks: e.tasks } }).catch(() => {})
  } else if (kind === "planner-repair-compatibility") {
    broadcast({ type: EventType.PlannerRepairCompatibility, data: { runId, attempt: e.attempt, mode: e.mode, activePath: e.activePath, diverged: e.diverged, divergenceScore: e.divergenceScore, divergenceThreshold: e.divergenceThreshold, pinnedToLegacy: e.pinnedToLegacy, reasons: e.reasons, legacy: e.legacy, repair: e.repair } })
    services.auditService.log({ actor: AuditActor.Agent, action: "planner.repair.compatibility", resourceType: "AgentRun", resourceId: runId, detail: { attempt: e.attempt, mode: e.mode, activePath: e.activePath, diverged: e.diverged, divergenceScore: e.divergenceScore, divergenceThreshold: e.divergenceThreshold, pinnedToLegacy: e.pinnedToLegacy, reasons: e.reasons } }).catch(() => {})
  }

  // Forward delegation + LLM debug events
  if (kind === "planner-delegation-start" || kind === "planner-delegation-iteration" || kind === "planner-delegation-end") {
    // already broadcast above
  } else if (kind === "llm-request" || kind === "llm-response" || kind === "nudge") {
    broadcastTrace(runId, debugSeqRef.value++, entry as TraceEntry)
  }
  void saveTrace // already called at top — keep TypeScript happy
}
