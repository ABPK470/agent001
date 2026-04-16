import type { EngineServices } from "@agent001/agent"
import { broadcast } from "../ws.js"

// ── Planner trace event dispatcher ───────────────────────────────

/**
 * Handle a single onPlannerTrace entry from the agent engine.
 * Routes each planner event kind to its WebSocket broadcast + audit log.
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
  broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry } })

  const kind = e.kind as string

  if (kind === "planner-decision" && e.shouldPlan) {
    broadcast({ type: "planner.started", data: { runId, score: e.score, reason: e.reason, route: e.route, coherenceNeed: e.coherenceNeed, coordinationNeed: e.coordinationNeed } })
    services.auditService.log({ actor: "agent", action: "planner.started", resourceType: "AgentRun", resourceId: runId, detail: { score: e.score, reason: e.reason, route: e.route, coherenceNeed: e.coherenceNeed, coordinationNeed: e.coordinationNeed } }).catch(() => {})
  } else if (kind === "planner-coherent-bootstrap") {
    broadcast({ type: "planner.coherent.bootstrap", data: { runId, artifactCount: e.artifactCount, decompositionStrategy: e.decompositionStrategy, decompositionReasons: e.decompositionReasons, sharedContracts: e.sharedContracts, invariants: e.invariants } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.bootstrap", resourceType: "AgentRun", resourceId: runId, detail: { artifactCount: e.artifactCount, decompositionStrategy: e.decompositionStrategy, decompositionReasons: e.decompositionReasons, sharedContracts: e.sharedContracts, invariants: e.invariants } }).catch(() => {})
  } else if (kind === "planner-architecture-state") {
    broadcast({ type: "planner.architecture.state", data: { runId, lane: e.lane, status: e.status, reason: e.reason, architecture: e.architecture } })
    services.auditService.log({ actor: "agent", action: "planner.architecture.state", resourceType: "AgentRun", resourceId: runId, detail: { lane: e.lane, status: e.status, reason: e.reason, architecture: e.architecture } }).catch(() => {})
  } else if (kind === "planner-pipeline-end") {
    broadcast({ type: "planner.completed", data: { runId, status: e.status, completedSteps: e.completedSteps, totalSteps: e.totalSteps } })
    services.auditService.log({ actor: "agent", action: e.status === "completed" ? "planner.completed" : "planner.failed", resourceType: "AgentRun", resourceId: runId, detail: { status: e.status, completedSteps: e.completedSteps, totalSteps: e.totalSteps } }).catch(() => {})
  } else if (kind === "planner-pipeline-start") {
    broadcast({ type: "planner.pipeline.started", data: { runId, attempt: e.attempt, maxRetries: e.maxRetries } })
  } else if (kind === "planner-validation-failed") {
    broadcast({ type: "planner.validation.failed", data: { runId, diagnostics: e.diagnostics } })
    services.auditService.log({ actor: "agent", action: "planner.validation.failed", resourceType: "AgentRun", resourceId: runId, detail: { diagnostics: e.diagnostics } }).catch(() => {})
  } else if (kind === "planner-validation-remediated") {
    broadcast({ type: "planner.validation.remediated", data: { runId, diagnostics: e.diagnostics } })
    services.auditService.log({ actor: "agent", action: "planner.validation.remediated", resourceType: "AgentRun", resourceId: runId, detail: { diagnostics: e.diagnostics } }).catch(() => {})
  } else if (kind === "planner-runtime-compiled") {
    broadcast({ type: "planner.runtime.compiled", data: { runId, executionSteps: e.executionSteps, ownershipArtifacts: e.ownershipArtifacts, runtimeEntities: e.runtimeEntities } })
    services.auditService.log({ actor: "agent", action: "planner.runtime.compiled", resourceType: "AgentRun", resourceId: runId, detail: { executionSteps: e.executionSteps, ownershipArtifacts: e.ownershipArtifacts, runtimeEntities: e.runtimeEntities } }).catch(() => {})
  } else if (kind === "coherent-generation-start") {
    broadcast({ type: "planner.coherent.started", data: { runId, route: e.route } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.started", resourceType: "AgentRun", resourceId: runId, detail: { route: e.route } }).catch(() => {})
  } else if (kind === "coherent-generation-bundle") {
    broadcast({ type: "planner.coherent.bundle", data: { runId, artifactCount: e.artifactCount, artifacts: e.artifacts, sharedContracts: e.sharedContracts, invariants: e.invariants } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.bundle", resourceType: "AgentRun", resourceId: runId, detail: { artifactCount: e.artifactCount, artifacts: e.artifacts, sharedContracts: e.sharedContracts, invariants: e.invariants } }).catch(() => {})
  } else if (kind === "coherent-generation-materialized") {
    broadcast({ type: "planner.coherent.materialized", data: { runId, artifactCount: e.artifactCount, artifacts: e.artifacts, readBackArtifacts: e.readBackArtifacts } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.materialized", resourceType: "AgentRun", resourceId: runId, detail: { artifactCount: e.artifactCount, artifacts: e.artifacts, readBackArtifacts: e.readBackArtifacts } }).catch(() => {})
  } else if (kind === "coherent-generation-verified") {
    broadcast({ type: "planner.coherent.verified", data: { runId, overall: e.overall, confidence: e.confidence, issueCount: e.issueCount, systemCheckCount: e.systemCheckCount, affectedArtifacts: e.affectedArtifacts } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.verified", resourceType: "AgentRun", resourceId: runId, detail: { overall: e.overall, confidence: e.confidence, issueCount: e.issueCount, systemCheckCount: e.systemCheckCount, affectedArtifacts: e.affectedArtifacts } }).catch(() => {})
  } else if (kind === "coherent-generation-repair-needed") {
    broadcast({ type: "planner.coherent.repair.required", data: { runId, repairAttempt: e.repairAttempt, issueCount: e.issueCount, issues: e.issues, affectedArtifacts: e.affectedArtifacts } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.repair.required", resourceType: "AgentRun", resourceId: runId, detail: { repairAttempt: e.repairAttempt, issueCount: e.issueCount, issues: e.issues, affectedArtifacts: e.affectedArtifacts } }).catch(() => {})
  } else if (kind === "coherent-generation-escalated") {
    broadcast({ type: "planner.coherent.repair.escalated", data: { runId, target: e.target, issueCount: e.issueCount, reason: e.reason } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.repair.escalated", resourceType: "AgentRun", resourceId: runId, detail: { target: e.target, issueCount: e.issueCount, reason: e.reason } }).catch(() => {})
  } else if (kind === "coherent-generation-handoff") {
    broadcast({ type: "planner.coherent.handoff", data: { runId, artifactCount: e.artifactCount, verificationRoute: e.verificationRoute } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.handoff", resourceType: "AgentRun", resourceId: runId, detail: { artifactCount: e.artifactCount, verificationRoute: e.verificationRoute } }).catch(() => {})
  } else if (kind === "coherent-generation-failed") {
    broadcast({ type: "planner.coherent.failed", data: { runId, stage: e.stage, diagnostics: e.diagnostics } })
    services.auditService.log({ actor: "agent", action: "planner.coherent.failed", resourceType: "AgentRun", resourceId: runId, detail: { stage: e.stage, diagnostics: e.diagnostics } }).catch(() => {})
  } else if (kind === "planner-step-start") {
    broadcast({ type: "planner.step.started", data: { runId, stepName: e.stepName, stepType: e.stepType } })
  } else if (kind === "planner-step-end") {
    broadcast({ type: "planner.step.completed", data: { runId, stepName: e.stepName, status: e.status, executionState: e.executionState, acceptanceState: e.acceptanceState, durationMs: e.durationMs, error: e.error, validationCode: e.validationCode, producedArtifacts: e.producedArtifacts, verificationAttempts: e.verificationAttempts, reconciliation: e.reconciliation } })
  } else if (kind === "planner-step-transition") {
    broadcast({ type: "planner.step.transition", data: { runId, attempt: e.attempt, stepName: e.stepName, phase: e.phase, state: e.state, timestamp: e.timestamp } })
  } else if (kind === "planner-delegation-start") {
    broadcast({ type: "planner.delegation.started", data: { runId, stepName: e.stepName, depth: e.depth, goal: e.goal, tools: e.tools } })
  } else if (kind === "planner-delegation-iteration") {
    broadcast({ type: "planner.delegation.iteration", data: { runId, stepName: e.stepName, depth: e.depth, iteration: e.iteration, maxIterations: e.maxIterations } })
  } else if (kind === "planner-delegation-end") {
    broadcast({ type: "planner.delegation.ended", data: { runId, stepName: e.stepName, depth: e.depth, status: e.status, answer: e.answer, error: e.error } })
  } else if (kind === "planner-verification") {
    broadcast({ type: "planner.verification", data: { runId, overall: e.overall, confidence: e.confidence, verifierRound: e.verifierRound, systemChecks: e.systemChecks, steps: e.steps } })
    services.auditService.log({ actor: "agent", action: "planner.verified", resourceType: "AgentRun", resourceId: runId, detail: { overall: e.overall, confidence: e.confidence, steps: e.steps } }).catch(() => {})
  } else if (kind === "planner-verification-followup") {
    broadcast({ type: "planner.verification.followup", data: { runId, requestedSteps: e.requestedSteps, reasons: e.reasons } })
  } else if (kind === "planner-issue-timeline") {
    broadcast({ type: "planner.issue.timeline", data: { runId, attempt: e.attempt, verifierRound: e.verifierRound, issues: e.issues } })
  } else if (kind === "planner-repair-plan") {
    broadcast({ type: "planner.repair.plan", data: { runId, attempt: e.attempt, epoch: e.epoch, rerunOrder: e.rerunOrder, tasks: e.tasks } })
    services.auditService.log({ actor: "agent", action: "planner.repair.plan", resourceType: "AgentRun", resourceId: runId, detail: { attempt: e.attempt, epoch: e.epoch, rerunOrder: e.rerunOrder, tasks: e.tasks } }).catch(() => {})
  } else if (kind === "planner-repair-compatibility") {
    broadcast({ type: "planner.repair.compatibility", data: { runId, attempt: e.attempt, mode: e.mode, activePath: e.activePath, diverged: e.diverged, divergenceScore: e.divergenceScore, divergenceThreshold: e.divergenceThreshold, pinnedToLegacy: e.pinnedToLegacy, reasons: e.reasons, legacy: e.legacy, repair: e.repair } })
    services.auditService.log({ actor: "agent", action: "planner.repair.compatibility", resourceType: "AgentRun", resourceId: runId, detail: { attempt: e.attempt, mode: e.mode, activePath: e.activePath, diverged: e.diverged, divergenceScore: e.divergenceScore, divergenceThreshold: e.divergenceThreshold, pinnedToLegacy: e.pinnedToLegacy, reasons: e.reasons } }).catch(() => {})
  }

  // Forward delegation + LLM debug events
  if (kind === "planner-delegation-start" || kind === "planner-delegation-iteration" || kind === "planner-delegation-end") {
    // already broadcast above
  } else if (kind === "llm-request" || kind === "llm-response" || kind === "nudge") {
    broadcast({ type: "debug.trace", data: { runId, seq: debugSeqRef.value++, entry } })
  }
  void saveTrace // already called at top — keep TypeScript happy
}
