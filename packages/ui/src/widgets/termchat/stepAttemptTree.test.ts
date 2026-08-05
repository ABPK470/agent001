import { describe, expect, it } from "vitest"
import type {
  ResponseStepBlockPart,
  ResponseToolPart,
} from "../../lib/events/build-chat-parts"
import { reconcilePlannerStepGroups } from "../../lib/events/reconcile-step-groups"
import {
  STEP_ATTEMPT_TREE,
  attemptChildKneeRem,
  collectRails,
  formatAttemptLabel,
  projectStepAttemptTree,
} from "./stepAttemptTree"
import { stepBlockHeaderChrome } from "./stepOutcomeChrome"

function tool(id: string, summary: string): ResponseToolPart {
  return {
    kind: "tool",
    id,
    row: {
      id,
      tool: "write_file",
      summary,
      status: "done",
    },
  }
}

function step(
  partial: Partial<ResponseStepBlockPart> & Pick<ResponseStepBlockPart, "id" | "title">,
): ResponseStepBlockPart {
  return {
    kind: "step-block",
    status: "done",
    tools: [],
    hasRunning: false,
    ...partial,
  }
}

describe("stepAttemptTree — rail hierarchy", () => {
  it("puts repaired attempts on the step rail and their tools one level under", () => {
    const block = step({
      id: "step-fe",
      title: "Subagent · frontend layer",
      stepName: "frontend_layer",
      subagent: true,
      outcome: "repaired",
      detail: "2.7s",
      durationMs: 2700,
      attempts: [
        {
          id: "a1",
          attempt: 1,
          repair: false,
          status: "failed",
          detail: "build failed — missing brand-tokens",
          durationMs: 1100,
          tools: [tool("t1", "Wrote <form>…"), tool("t2", "Failed npm run build")],
          hasRunning: false,
        },
        {
          id: "a2",
          attempt: 2,
          repair: true,
          status: "passed",
          detail: "1.6s",
          durationMs: 1600,
          tools: [tool("t3", "Wrote brand tokens"), tool("t4", "Ran npm run build")],
          hasRunning: false,
        },
      ],
      // Check exists on the model but must not appear once repaired.
      check: {
        label: "Checked work",
        status: "done",
        afterAttemptIndex: 0,
      },
    })

    const tree = projectStepAttemptTree(block)
    expect(tree.mode).toBe("nested-attempts")
    if (tree.mode !== "nested-attempts") return

    // Two attempt parents on the primary rail — never mid-offset floaters.
    expect(tree.attempts.map((a) => a.rail)).toEqual(["step", "step"])
    expect(tree.attempts.map((a) => a.role)).toEqual(["attempt", "attempt"])

    // Every tool hangs under an attempt — not a step-rail sibling of Attempt.
    for (const attempt of tree.attempts) {
      expect(attempt.children.length).toBeGreaterThan(0)
      expect(attempt.children.every((c) => c.rail === "attempt")).toBe(true)
      expect(attempt.children.every((c) => c.role === "tool")).toBe(true)
    }

    // No tool at step depth when attempts nest (the visual disconnect bug).
    expect(collectRails(tree).filter((r) => r === "step")).toEqual(["step", "step"])
    expect(collectRails(tree).filter((r) => r === "attempt")).toHaveLength(4)

    // Labels read as connected parents, not bare section headers.
    expect(tree.attempts[0]?.label).toBe(
      "Attempt 1 — failed: build failed — missing brand-tokens",
    )
    expect(tree.attempts[1]?.label).toBe("Attempt 2 (repair) — passed · 1.6s")

    // Repaired: verify stays off the chat tree (quiet answer flow).
    expect(
      tree.attempts.flatMap((a) => a.children).some((c) => c.role === "check"),
    ).toBe(false)
  })

  it("keeps plain subagent tools on the step rail (schema-layer shape)", () => {
    const block = step({
      id: "step-schema",
      title: "Subagent · schema layer",
      stepName: "schema_layer",
      subagent: true,
      outcome: "passed",
      detail: "1.8s",
      tools: [tool("q1", "Blocked SELECT *"), tool("q2", "Queried clients")],
    })

    const tree = projectStepAttemptTree(block)
    expect(tree.mode).toBe("flat-tools")
    if (tree.mode !== "flat-tools") return
    expect(tree.tools.map((t) => t.rail)).toEqual(["step", "step"])
    expect(collectRails(tree)).toEqual(["step", "step"])
  })

  it("nests mid-loop check under the failed attempt while still open", () => {
    const block = step({
      id: "step-fe",
      title: "Subagent · frontend layer",
      outcome: "failed",
      attempts: [
        {
          id: "a1",
          attempt: 1,
          repair: false,
          status: "failed",
          detail: "missing brand-tokens",
          tools: [tool("t1", "Wrote form")],
          hasRunning: false,
        },
      ],
      check: {
        label: "Check · needs work",
        status: "done",
        afterAttemptIndex: 0,
      },
    })

    const tree = projectStepAttemptTree(block)
    expect(tree.mode).toBe("nested-attempts")
    if (tree.mode !== "nested-attempts") return
    const kids = tree.attempts[0]?.children ?? []
    expect(kids.map((c) => c.role)).toEqual(["tool", "check"])
    expect(kids.every((c) => c.rail === "attempt")).toBe(true)
  })
})

describe("stepAttemptTree — nest geometry contract", () => {
  it("keeps child knee offset equal to nest width (no gutter rail)", () => {
    // The visual bug: knee −1.5rem inside nest 0.75rem parked the child
    // rail left of Attempt. Contract: knee rem === nest rem.
    expect(attemptChildKneeRem()).toBe(STEP_ATTEMPT_TREE.attemptNestRem)
    expect(attemptChildKneeRem()).toBe(0.75)
    expect(STEP_ATTEMPT_TREE.primaryKneeRem).toBeGreaterThan(
      STEP_ATTEMPT_TREE.attemptNestRem,
    )
    expect(attemptChildKneeRem(STEP_ATTEMPT_TREE.attemptNestRem)).not.toBe(
      STEP_ATTEMPT_TREE.primaryKneeRem,
    )
  })
})

describe("stepAttemptTree — header duration vs attempt walls", () => {
  it("header chrome uses summed duration, not the last attempt alone", () => {
    const parts = reconcilePlannerStepGroups([
      step({
        id: "step-frontend_layer-1",
        title: "Subagent · frontend layer",
        stepName: "frontend_layer",
        subagent: true,
        body: "build failed — missing brand-tokens",
        detail: "build failed — missing brand-tokens",
        durationMs: 1100,
        tools: [tool("t1", "Wrote form")],
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
        tools: [tool("t2", "Wrote tokens")],
      }),
    ])

    const block = parts[0]
    expect(block?.kind).toBe("step-block")
    if (block?.kind !== "step-block") return

    // Domain rollup: total wall, not echo of Attempt 2.
    expect(block.durationMs).toBe(2700)
    expect(block.detail).toBe("2.7s")
    expect(block.attempts?.[1]?.detail).toBe("1.6s")
    expect(block.detail).not.toBe(block.attempts?.[1]?.detail)

    const tree = projectStepAttemptTree(block)
    expect(tree.mode).toBe("nested-attempts")
    if (tree.mode !== "nested-attempts") return

    const attemptWalls = tree.attempts.map((a) => a.durationMs)
    expect(attemptWalls).toEqual([1100, 1600])
    expect(block.durationMs).toBe(
      attemptWalls.reduce<number>((n, ms) => n + (ms ?? 0), 0),
    )

    // Tools stay under their attempt — first attempt owns t1, repair owns t2.
    expect(
      tree.attempts[0]?.children.filter((c) => c.role === "tool").map((c) => c.id),
    ).toEqual(["t1"])
    expect(
      tree.attempts[1]?.children.filter((c) => c.role === "tool").map((c) => c.id),
    ).toEqual(["t2"])

    const chrome = stepBlockHeaderChrome({
      outcome: block.outcome,
      detail: block.detail,
      isRetrying: false,
      isFailed: false,
    })
    expect(chrome).toEqual({ kind: "muted", text: "· 2.7s (auto-repaired)" })
    expect(chrome && chrome.kind === "muted" ? chrome.text : "").not.toContain("1.6s")
  })
})

describe("formatAttemptLabel", () => {
  it("names repair vs initial and keeps failure detail on the attempt row", () => {
    expect(
      formatAttemptLabel({
        id: "a1",
        attempt: 1,
        repair: false,
        status: "failed",
        detail: "build failed — missing brand-tokens",
        tools: [],
        hasRunning: false,
      }),
    ).toBe("Attempt 1 — failed: build failed — missing brand-tokens")

    expect(
      formatAttemptLabel({
        id: "a2",
        attempt: 2,
        repair: true,
        status: "passed",
        detail: "1.6s",
        tools: [],
        hasRunning: false,
      }),
    ).toBe("Attempt 2 (repair) — passed · 1.6s")
  })
})
