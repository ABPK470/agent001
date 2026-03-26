import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
    ApprovalStatus,
    RunStatus,
    StepStatus,
    WorkflowStatus,
} from "../../src/domain/enums.js"
import { InvalidTransitionError } from "../../src/domain/errors.js"
import {
    activateWorkflow,
    approveRequest,
    archiveWorkflow,
    cancelRun,
    completeRun,
    createApprovalRequest,
    createRun,
    createWorkflow,
    currentStep,
    rejectRequest,
    resumeRun,
    startPlanning,
    startRunning,
    waitForApproval,
    type Step,
} from "../../src/domain/models.js"

function fakeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    definitionId: "s1",
    name: "s",
    action: "fake",
    input: {},
    condition: null,
    onError: "fail",
    status: StepStatus.Pending,
    order: 0,
    output: {},
    error: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

describe("Workflow transitions", () => {
  it("activates from draft", () => {
    const wf = createWorkflow({
      name: "W",
      description: "",
      inputSchema: {},
      steps: [{ id: "s", name: "s", action: "a", input: {} }],
    })
    activateWorkflow(wf)
    expect(wf.status).toBe(WorkflowStatus.Active)
  })

  it("archives from active", () => {
    const wf = createWorkflow({
      name: "W",
      description: "",
      inputSchema: {},
      steps: [{ id: "s", name: "s", action: "a", input: {} }],
    })
    activateWorkflow(wf)
    archiveWorkflow(wf)
    expect(wf.status).toBe(WorkflowStatus.Archived)
  })

  it("rejects archive from draft", () => {
    const wf = createWorkflow({
      name: "W",
      description: "",
      inputSchema: {},
      steps: [{ id: "s", name: "s", action: "a", input: {} }],
    })
    expect(() => archiveWorkflow(wf)).toThrow(InvalidTransitionError)
  })
})

describe("Run transitions", () => {
  it("happy path", () => {
    const run = createRun("w1")
    startPlanning(run)
    startRunning(run, [fakeStep()])
    expect(run.status).toBe(RunStatus.Running)
    completeRun(run)
    expect(run.status).toBe(RunStatus.Completed)
    expect(run.completedAt).toBeTruthy()
  })

  it("approval cycle", () => {
    const run = createRun("w1")
    startPlanning(run)
    startRunning(run, [])
    waitForApproval(run)
    expect(run.status).toBe(RunStatus.WaitingForApproval)
    resumeRun(run)
    expect(run.status).toBe(RunStatus.Running)
  })

  it("cancel", () => {
    const run = createRun("w1")
    startPlanning(run)
    startRunning(run, [])
    cancelRun(run)
    expect(run.status).toBe(RunStatus.Cancelled)
  })

  it("currentStep returns first non-terminal step", () => {
    const s1 = fakeStep({ status: StepStatus.Completed })
    const s2 = fakeStep({ definitionId: "s2" })
    const run = createRun("w1")
    run.steps = [s1, s2]
    expect(currentStep(run)).toBe(s2)
  })
})

describe("ApprovalRequest transitions", () => {
  it("approve", () => {
    const req = createApprovalRequest({
      runId: "r",
      stepId: "s",
      reason: "r",
      policyName: "p",
    })
    approveRequest(req, "alice")
    expect(req.status).toBe(ApprovalStatus.Approved)
    expect(req.resolvedBy).toBe("alice")
  })

  it("reject", () => {
    const req = createApprovalRequest({
      runId: "r",
      stepId: "s",
      reason: "r",
      policyName: "p",
    })
    rejectRequest(req, "bob")
    expect(req.status).toBe(ApprovalStatus.Rejected)
  })

  it("double resolve throws", () => {
    const req = createApprovalRequest({
      runId: "r",
      stepId: "s",
      reason: "r",
      policyName: "p",
    })
    approveRequest(req, "alice")
    expect(() => rejectRequest(req, "bob")).toThrow(InvalidTransitionError)
  })
})
