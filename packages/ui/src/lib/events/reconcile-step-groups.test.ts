import { describe, expect, it } from "vitest"
import type { ResponsePart, ResponseStepBlockPart } from "./build-chat-parts"
import {
  deriveStepBlockOutcome,
  reconcilePlannerStepGroups,
  sumAttemptDurationMs,
} from "./reconcile-step-groups"

function step(
  partial: Partial<ResponseStepBlockPart> & Pick<ResponseStepBlockPart, "id" | "title" | "stepName">,
): ResponseStepBlockPart {
  return {
    kind: "step-block",
    status: "done",
    tools: [],
    hasRunning: false,
    ...partial,
  }
}

describe("deriveStepBlockOutcome", () => {
  it("marks repaired when an earlier attempt failed and the last passed", () => {
    expect(
      deriveStepBlockOutcome([
        {
          id: "a1",
          attempt: 1,
          repair: false,
          status: "failed",
          tools: [],
          hasRunning: false,
        },
        {
          id: "a2",
          attempt: 2,
          repair: true,
          status: "passed",
          tools: [],
          hasRunning: false,
        },
      ]),
    ).toBe("repaired")
  })

  it("stays failed when the last attempt failed", () => {
    expect(
      deriveStepBlockOutcome([
        {
          id: "a1",
          attempt: 1,
          repair: false,
          status: "failed",
          tools: [],
          hasRunning: false,
        },
        {
          id: "a2",
          attempt: 2,
          repair: true,
          status: "failed",
          tools: [],
          hasRunning: false,
        },
      ]),
    ).toBe("failed")
  })
})

describe("reconcilePlannerStepGroups", () => {
  it("sums attempt durations for the step header (not last-attempt only)", () => {
    expect(
      sumAttemptDurationMs([{ durationMs: 1100 }, { durationMs: 1600 }]),
    ).toBe(2700)
  })

  it("folds repair peer under the domain step and attaches check", () => {
    const parts: ResponsePart[] = [
      step({
        id: "step-frontend_layer-1",
        title: "Subagent · frontend layer",
        stepName: "frontend_layer",
        subagent: true,
        body: "build failed — missing brand-tokens",
        detail: "build failed — missing brand-tokens",
        durationMs: 1100,
      }),
      {
        kind: "progress",
        id: "verification-2",
        label: "Check · needs work",
        status: "done",
        detail: "frontend layer",
        body: "frontend layer: missing brand-tokens",
      },
      step({
        id: "step-frontend_layer-3",
        title: "Repair · frontend layer",
        stepName: "frontend_layer",
        subagent: true,
        repair: true,
        detail: "1.6s",
        durationMs: 1600,
      }),
    ]

    const out = reconcilePlannerStepGroups(parts)
    expect(out.filter((p) => p.kind === "step-block")).toHaveLength(1)
    expect(out.some((p) => p.kind === "progress")).toBe(false)

    const block = out[0]
    expect(block?.kind).toBe("step-block")
    if (block?.kind !== "step-block") return
    expect(block.title).toBe("Subagent · frontend layer")
    expect(block.outcome).toBe("repaired")
    expect(block.repair).toBeUndefined()
    expect(block.durationMs).toBe(2700)
    expect(block.detail).toBe("2.7s")
    expect(block.attempts).toHaveLength(2)
    expect(block.attempts?.[0]?.status).toBe("failed")
    expect(block.attempts?.[1]?.repair).toBe(true)
    expect(block.attempts?.[1]?.status).toBe("passed")
    expect(block.attempts?.[1]?.detail).toBe("1.6s")
    expect(block.check?.label).toBe("Check · needs work")
    // Mid-loop check belongs after attempt 1, before the repair attempt.
    expect(block.check?.afterAttemptIndex).toBe(0)
  })

  it("resolves needs-work to Checked work after repair pass (no terminal fail check)", () => {
    const parts: ResponsePart[] = [
      step({
        id: "step-frontend_layer-1",
        title: "Subagent · frontend layer",
        stepName: "frontend_layer",
        subagent: true,
        body: "build failed",
        detail: "build failed",
      }),
      {
        kind: "progress",
        id: "verification-2",
        label: "Check · needs work",
        status: "done",
        detail: "frontend layer",
        body: "frontend layer: missing brand-tokens",
      },
      step({
        id: "step-frontend_layer-3",
        title: "Repair · frontend layer",
        stepName: "frontend_layer",
        subagent: true,
        repair: true,
        detail: "attempt 1",
      }),
      {
        kind: "progress",
        id: "verification-4",
        label: "Checked work",
        status: "done",
      },
    ]
    const out = reconcilePlannerStepGroups(parts)
    const block = out[0]
    expect(block?.kind).toBe("step-block")
    if (block?.kind !== "step-block") return
    expect(block.outcome).toBe("repaired")
    expect(block.check?.label).toBe("Checked work")
    expect(block.check?.body).toBeUndefined()
    expect(block.check?.afterAttemptIndex).toBe(0)
  })

  it("omits Checked work from the answer axis after a clean pass", () => {
    const parts: ResponsePart[] = [
      step({
        id: "step-schema-1",
        title: "Subagent · schema layer",
        stepName: "schema_layer",
        subagent: true,
        detail: "1.2s",
      }),
      {
        kind: "progress",
        id: "verification-2",
        label: "Checked work",
        status: "done",
      },
    ]
    const out = reconcilePlannerStepGroups(parts)
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("step-block")
  })

  it("nests needs-work check under a single failed step (no repair yet)", () => {
    const parts: ResponsePart[] = [
      step({
        id: "step-frontend_layer-1",
        title: "Subagent · frontend layer",
        stepName: "frontend_layer",
        subagent: true,
        body: "missing brand-tokens",
        detail: "missing brand-tokens",
      }),
      {
        kind: "progress",
        id: "verification-2",
        label: "Check · needs work",
        status: "done",
        detail: "frontend layer",
        body: "frontend layer: missing brand-tokens",
      },
    ]
    const out = reconcilePlannerStepGroups(parts)
    expect(out).toHaveLength(1)
    const block = out[0]
    expect(block?.kind).toBe("step-block")
    if (block?.kind !== "step-block") return
    expect(block.outcome).toBe("failed")
    expect(block.check?.label).toBe("Check · needs work")
    expect(block.attempts).toHaveLength(1)
  })
})
