import { describe, expect, it } from "vitest"
import { PolicyEffect, RunStatus, StepStatus } from "../../src/domain/enums.js"
import { ApprovalRequiredError } from "../../src/domain/errors.js"
import {
    buildTestDeps,
    FailingAction,
    FakeAction,
    makeWorkflow,
} from "../helpers.js"

describe("Orchestrator", () => {
  it("executes a single-step workflow", async () => {
    const deps = buildTestDeps()
    const fake = new FakeAction("fake", { result: "done" })
    deps.actionRegistry.register(fake)

    const wf = makeWorkflow()
    const run = await deps.orchestrator.startRun(wf)

    expect(run.status).toBe(RunStatus.Completed)
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0].status).toBe(StepStatus.Completed)
    expect(run.steps[0].output).toEqual({ result: "done" })
    expect(fake.calls).toHaveLength(1)
  })

  it("executes multi-step workflow in order", async () => {
    const deps = buildTestDeps()
    const order: string[] = []
    deps.actionRegistry.register({
      name: "track",
      async execute(input) {
        order.push(String(input["id"]))
        return { tracked: input["id"] }
      },
    })

    const wf = makeWorkflow({
      steps: [
        { id: "s1", name: "S1", action: "track", input: { id: "first" } },
        {
          id: "s2",
          name: "S2",
          action: "track",
          input: { id: "second" },
          dependsOn: ["s1"],
        },
        {
          id: "s3",
          name: "S3",
          action: "track",
          input: { id: "third" },
          dependsOn: ["s2"],
        },
      ],
    })

    const run = await deps.orchestrator.startRun(wf)
    expect(run.status).toBe(RunStatus.Completed)
    expect(order).toEqual(["first", "second", "third"])
  })

  it("resolves expressions between steps", async () => {
    const deps = buildTestDeps()
    const results: Record<string, unknown>[] = []
    deps.actionRegistry.register({
      name: "capture",
      async execute(input) {
        results.push(input)
        return { value: 42 }
      },
    })

    const wf = makeWorkflow({
      steps: [
        { id: "s1", name: "S1", action: "capture", input: { x: 1 } },
        {
          id: "s2",
          name: "S2",
          action: "capture",
          input: { prev: "{{steps.s1.output.value}}" },
          dependsOn: ["s1"],
        },
      ],
    })

    const run = await deps.orchestrator.startRun(wf, { userId: "u1" })
    expect(run.status).toBe(RunStatus.Completed)
    expect(results[1]).toEqual({ prev: 42 })
  })

  it("resolves input expressions", async () => {
    const deps = buildTestDeps()
    let captured: Record<string, unknown> = {}
    deps.actionRegistry.register({
      name: "capture",
      async execute(input) {
        captured = input
        return {}
      },
    })

    const wf = makeWorkflow({
      steps: [
        {
          id: "s1",
          name: "S1",
          action: "capture",
          input: { user: "{{input.name}}" },
        },
      ],
    })

    await deps.orchestrator.startRun(wf, { name: "bob" })
    expect(captured).toEqual({ user: "bob" })
  })

  it("skips step when condition is falsy", async () => {
    const deps = buildTestDeps()
    const fake = new FakeAction("fake")
    deps.actionRegistry.register(fake)

    const wf = makeWorkflow({
      steps: [
        {
          id: "s1",
          name: "S1",
          action: "fake",
          input: {},
          condition: "{{input.go}} == true",
        },
      ],
    })

    const run = await deps.orchestrator.startRun(wf, { go: false })
    expect(run.status).toBe(RunStatus.Completed)
    expect(run.steps[0].status).toBe(StepStatus.Skipped)
    expect(fake.calls).toHaveLength(0)
  })

  it("runs step when condition is truthy", async () => {
    const deps = buildTestDeps()
    const fake = new FakeAction("fake")
    deps.actionRegistry.register(fake)

    const wf = makeWorkflow({
      steps: [
        {
          id: "s1",
          name: "S1",
          action: "fake",
          input: {},
          condition: "{{input.go}} == true",
        },
      ],
    })

    const run = await deps.orchestrator.startRun(wf, { go: true })
    expect(run.status).toBe(RunStatus.Completed)
    expect(run.steps[0].status).toBe(StepStatus.Completed)
    expect(fake.calls).toHaveLength(1)
  })

  it("fails the run on step failure with onError=fail", async () => {
    const deps = buildTestDeps()
    deps.actionRegistry.register(new FailingAction("fake"))

    const wf = makeWorkflow({
      steps: [{ id: "s1", name: "S1", action: "fake", input: {} }],
    })

    const run = await deps.orchestrator.startRun(wf)
    expect(run.status).toBe(RunStatus.Failed)
    expect(run.steps[0].status).toBe(StepStatus.Failed)
    expect(run.steps[0].error).toBe("boom")
  })

  it("skips failed step with onError=skip", async () => {
    const deps = buildTestDeps()
    deps.actionRegistry.register(new FailingAction("failing"))
    deps.actionRegistry.register(new FakeAction("fake", { done: true }))

    const wf = makeWorkflow({
      steps: [
        { id: "s1", name: "S1", action: "failing", input: {}, onError: "skip" },
        { id: "s2", name: "S2", action: "fake", input: {}, dependsOn: ["s1"] },
      ],
    })

    const run = await deps.orchestrator.startRun(wf)
    expect(run.status).toBe(RunStatus.Completed)
    expect(run.steps[0].status).toBe(StepStatus.Skipped)
    expect(run.steps[1].status).toBe(StepStatus.Completed)
  })

  it("continues past failed step with onError=continue", async () => {
    const deps = buildTestDeps()
    deps.actionRegistry.register(new FailingAction("failing"))
    deps.actionRegistry.register(new FakeAction("fake"))

    const wf = makeWorkflow({
      steps: [
        {
          id: "s1",
          name: "S1",
          action: "failing",
          input: {},
          onError: "continue",
        },
        { id: "s2", name: "S2", action: "fake", input: {}, dependsOn: ["s1"] },
      ],
    })

    const run = await deps.orchestrator.startRun(wf)
    expect(run.status).toBe(RunStatus.Completed)
    expect(run.steps[0].status).toBe(StepStatus.Failed)
    expect(run.steps[1].status).toBe(StepStatus.Completed)
  })

  it("blocks on policy requiring approval", async () => {
    const deps = buildTestDeps()
    deps.actionRegistry.register(new FakeAction("fake"))
    deps.policyEvaluator.addRule({
      name: "big-amount",
      effect: PolicyEffect.RequireApproval,
      condition: "amount_gt:100",
      parameters: {},
    })

    const wf = makeWorkflow({
      steps: [{ id: "s1", name: "S1", action: "fake", input: { amount: 500 } }],
    })

    await expect(deps.orchestrator.startRun(wf)).rejects.toThrow(
      ApprovalRequiredError,
    )

    const pending = await deps.approvalRepo.listPending()
    expect(pending).toHaveLength(1)
  })

  it("resumes after approval", async () => {
    const deps = buildTestDeps()
    deps.actionRegistry.register(new FakeAction("fake"))
    deps.policyEvaluator.addRule({
      name: "big-amount",
      effect: PolicyEffect.RequireApproval,
      condition: "amount_gt:100",
      parameters: {},
    })

    const wf = makeWorkflow({
      steps: [{ id: "s1", name: "S1", action: "fake", input: { amount: 500 } }],
    })

    // Start — blocked
    let run: Awaited<ReturnType<typeof deps.orchestrator.startRun>>
    try {
      run = await deps.orchestrator.startRun(wf)
    } catch {
      // expected ApprovalRequiredError
    }

    // Approve and remove the policy so resume succeeds
    const pending = await deps.approvalRepo.listPending()
    expect(pending).toHaveLength(1)
    deps.policyEvaluator.removeRule("big-amount")

    // Get run from repo
    const runs = await deps.runRepo.listByWorkflow(wf.id)
    run = runs[0]
    const resumed = await deps.orchestrator.resume(run)
    expect(resumed.status).toBe(RunStatus.Completed)
  })

  it("emits domain events", async () => {
    const deps = buildTestDeps()
    deps.actionRegistry.register(new FakeAction("fake"))

    const wf = makeWorkflow()
    await deps.orchestrator.startRun(wf)

    const types = deps.eventBus.history.map((e) => e.type)
    expect(types).toContain("run.started")
    expect(types).toContain("step.started")
    expect(types).toContain("step.completed")
    expect(types).toContain("run.completed")
  })

  it("records execution history via learner", async () => {
    const deps = buildTestDeps()
    deps.actionRegistry.register(new FakeAction("fake"))

    const wf = makeWorkflow()
    const run = await deps.orchestrator.startRun(wf)

    const stats = await deps.learner.statsFor("fake")
    expect(stats.total).toBe(1)
    expect(stats.successes).toBe(1)
  })
})
