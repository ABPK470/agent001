import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { MemoryEventBus } from "../../src/adapters/memory-event-bus.js"
import {
    MemoryApprovalRepository,
    MemoryAuditRepository,
} from "../../src/adapters/memory-repositories.js"
import { ApprovalStatus, PolicyEffect, RunStatus, StepStatus } from "../../src/domain/enums.js"
import { PolicyViolationError } from "../../src/domain/errors.js"
import {
    createApprovalRequest,
    type Step,
    type WorkflowRun,
} from "../../src/domain/models.js"
import { ApprovalService } from "../../src/governance/approval-service.js"
import { AuditService } from "../../src/governance/audit-service.js"
import { RulePolicyEvaluator } from "../../src/governance/policy-engine.js"

function fakeRunAndStep(
  stepInput: Record<string, unknown> = {},
  action = "test",
): { run: WorkflowRun; step: Step } {
  const step: Step = {
    id: randomUUID(),
    definitionId: "s1",
    name: "S1",
    action,
    input: stepInput,
    condition: null,
    onError: "fail",
    status: StepStatus.Pending,
    order: 0,
    output: {},
    error: null,
    startedAt: null,
    completedAt: null,
  }
  const run: WorkflowRun = {
    id: randomUUID(),
    workflowId: "w1",
    input: {},
    status: RunStatus.Running,
    steps: [step],
    createdAt: new Date(),
    completedAt: null,
  }
  return { run, step }
}

describe("RulePolicyEvaluator", () => {
  it("returns null when no rules match", async () => {
    const pe = new RulePolicyEvaluator()
    const { run, step } = fakeRunAndStep()
    expect(await pe.evaluatePreStep(run, step)).toBeNull()
  })

  it("requires approval for amount_gt rule", async () => {
    const pe = new RulePolicyEvaluator()
    pe.addRule({
      name: "big-spend",
      effect: PolicyEffect.RequireApproval,
      condition: "amount_gt:1000",
      parameters: {},
    })
    const { run, step } = fakeRunAndStep({ amount: 5000 })
    const reason = await pe.evaluatePreStep(run, step)
    expect(reason).toContain("big-spend")
  })

  it("does not trigger amount_gt when under threshold", async () => {
    const pe = new RulePolicyEvaluator()
    pe.addRule({
      name: "big-spend",
      effect: PolicyEffect.RequireApproval,
      condition: "amount_gt:1000",
      parameters: {},
    })
    const { run, step } = fakeRunAndStep({ amount: 500 })
    expect(await pe.evaluatePreStep(run, step)).toBeNull()
  })

  it("throws on deny policy", async () => {
    const pe = new RulePolicyEvaluator()
    pe.addRule({
      name: "no-http",
      effect: PolicyEffect.Deny,
      condition: "action:http.request",
      parameters: {},
    })
    const { run, step } = fakeRunAndStep({}, "http.request")
    await expect(pe.evaluatePreStep(run, step)).rejects.toThrow(
      PolicyViolationError,
    )
  })

  it("matches action condition", async () => {
    const pe = new RulePolicyEvaluator()
    pe.addRule({
      name: "approve-http",
      effect: PolicyEffect.RequireApproval,
      condition: "action:http.request",
      parameters: {},
    })
    const { run, step } = fakeRunAndStep({}, "http.request")
    expect(await pe.evaluatePreStep(run, step)).toContain("approve-http")
  })

  it("removeRule works", async () => {
    const pe = new RulePolicyEvaluator()
    pe.addRule({
      name: "r1",
      effect: PolicyEffect.Deny,
      condition: "action:x",
      parameters: {},
    })
    pe.removeRule("r1")
    expect(pe.listRules()).toHaveLength(0)
  })
})

describe("ApprovalService", () => {
  it("resolves an approval", async () => {
    const repo = new MemoryApprovalRepository()
    const bus = new MemoryEventBus()
    const svc = new ApprovalService(repo, bus)

    const req = createApprovalRequest({
      runId: "r1",
      stepId: "s1",
      reason: "big",
      policyName: "p",
    })
    await repo.save(req)

    const resolved = await svc.resolve(req.id, true, "admin")
    expect(resolved.status).toBe(ApprovalStatus.Approved)
    expect(resolved.resolvedBy).toBe("admin")
    expect(bus.history.some((e) => e.type === "approval.resolved")).toBe(true)
  })

  it("lists pending approvals", async () => {
    const repo = new MemoryApprovalRepository()
    const bus = new MemoryEventBus()
    const svc = new ApprovalService(repo, bus)

    const req1 = createApprovalRequest({
      runId: "r1",
      stepId: "s1",
      reason: "a",
      policyName: "p",
    })
    const req2 = createApprovalRequest({
      runId: "r2",
      stepId: "s2",
      reason: "b",
      policyName: "p",
    })
    await repo.save(req1)
    await repo.save(req2)

    const pending = await svc.listPending()
    expect(pending).toHaveLength(2)
  })

  it("throws on unknown approval id", async () => {
    const repo = new MemoryApprovalRepository()
    const bus = new MemoryEventBus()
    const svc = new ApprovalService(repo, bus)

    await expect(svc.resolve("nonexistent", true, "admin")).rejects.toThrow(
      "not found",
    )
  })
})

describe("AuditService", () => {
  it("logs and retrieves audit entries", async () => {
    const repo = new MemoryAuditRepository()
    const svc = new AuditService(repo)

    await svc.log({
      actor: "system",
      action: "run.started",
      resourceType: "run",
      resourceId: "r1",
    })
    await svc.log({
      actor: "system",
      action: "run.completed",
      resourceType: "run",
      resourceId: "r1",
    })
    await svc.log({
      actor: "system",
      action: "run.started",
      resourceType: "run",
      resourceId: "r2",
    })

    const entries = await svc.history("run", "r1")
    expect(entries).toHaveLength(2)
  })
})
