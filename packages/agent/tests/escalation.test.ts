/**
 * Tests for escalation.ts — deterministic escalation graph.
 */

import { describe, expect, it } from "vitest"
import {
    buildEscalationInput,
    resolveEscalation,
    type EscalationInput,
} from "../src/escalation.js"

// ============================================================================
// Helpers
// ============================================================================

function makeInput(overrides: Partial<EscalationInput> = {}): EscalationInput {
  return {
    verdict: "retry",
    attempt: 0,
    maxAttempts: 3,
    disagreements: 0,
    maxDisagreements: 3,
    revisionAvailable: true,
    reexecuteOnNeedsRevision: true,
    ...overrides,
  }
}

// ============================================================================
// resolveEscalation
// ============================================================================

describe("resolveEscalation", () => {
  describe("hard stops", () => {
    it("escalates on timeout", () => {
      const result = resolveEscalation(makeInput({ timedOut: true }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("timeout")
    })

    it("escalates on budget exhausted", () => {
      const result = resolveEscalation(makeInput({ budgetExhausted: true }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("budget_exhausted")
    })

    it("escalates when all steps are stuck", () => {
      const result = resolveEscalation(makeInput({ allStepsStuck: true }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("all_steps_stuck")
    })

    it("timeout takes priority over pass verdict", () => {
      const result = resolveEscalation(makeInput({ verdict: "pass", timedOut: true }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("timeout")
    })
  })

  describe("success path", () => {
    it("passes when verdict is pass", () => {
      const result = resolveEscalation(makeInput({ verdict: "pass" }))
      expect(result.action).toBe("pass")
      expect(result.reason).toBe("pass")
    })
  })

  describe("disagreement threshold", () => {
    it("escalates when disagreements exceed threshold", () => {
      const result = resolveEscalation(makeInput({ disagreements: 3, maxDisagreements: 3 }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("disagreement_threshold")
    })

    it("allows retry when disagreements below threshold", () => {
      const result = resolveEscalation(makeInput({ disagreements: 2, maxDisagreements: 3 }))
      expect(result.action).not.toBe("escalate")
    })
  })

  describe("attempt limits", () => {
    it("escalates when at max attempts", () => {
      const result = resolveEscalation(makeInput({ attempt: 2, maxAttempts: 3 }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("retries_exhausted")
    })

    it("allows retry when attempts remain", () => {
      const result = resolveEscalation(makeInput({ attempt: 1, maxAttempts: 3 }))
      expect(result.action).not.toBe("escalate")
    })
  })

  describe("fail verdict", () => {
    it("revises on fail when a revision path exists", () => {
      const result = resolveEscalation(makeInput({ verdict: "fail", revisionAvailable: true }))
      expect(result.action).toBe("revise")
      expect(result.reason).toBe("needs_revision")
    })

    it("escalates on fail when no revision path exists", () => {
      const result = resolveEscalation(makeInput({ verdict: "fail", revisionAvailable: false }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("retries_exhausted")
    })

    it("keeps revising on fail while attempts remain", () => {
      const result = resolveEscalation(makeInput({ verdict: "fail", revisionAvailable: true, attempt: 1 }))
      expect(result.action).toBe("revise")
      expect(result.reason).toBe("needs_revision")
    })

    it("escalates on repeated fail when the run is marked stuck", () => {
      const result = resolveEscalation(makeInput({
        verdict: "fail",
        revisionAvailable: true,
        attempt: 1,
        allStepsStuck: true,
      }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("all_steps_stuck")
    })
  })

  describe("retry verdict with revision", () => {
    it("revises when revision is available", () => {
      const result = resolveEscalation(makeInput({
        verdict: "retry",
        revisionAvailable: true,
      }))
      expect(result.action).toBe("revise")
      expect(result.reason).toBe("needs_revision")
    })

    it("retries when revision unavailable but reexecute allowed", () => {
      const result = resolveEscalation(makeInput({
        verdict: "retry",
        revisionAvailable: false,
        reexecuteOnNeedsRevision: true,
      }))
      expect(result.action).toBe("retry")
      expect(result.reason).toBe("retry_allowed")
    })

    it("escalates when no revision and no reexecute", () => {
      const result = resolveEscalation(makeInput({
        verdict: "retry",
        revisionAvailable: false,
        reexecuteOnNeedsRevision: false,
      }))
      expect(result.action).toBe("escalate")
      expect(result.reason).toBe("revision_unavailable")
    })
  })
})

// ============================================================================
// buildEscalationInput
// ============================================================================

describe("buildEscalationInput", () => {
  it("builds input from planner state", () => {
    const input = buildEscalationInput({
      verifierOverall: "retry",
      attempt: 1,
      maxAttempts: 3,
      hasRetryableSteps: true,
      allStepsRepeatedFailure: false,
    })

    expect(input.verdict).toBe("retry")
    expect(input.attempt).toBe(1)
    expect(input.maxAttempts).toBe(3)
    expect(input.revisionAvailable).toBe(true)
    expect(input.reexecuteOnNeedsRevision).toBe(true)
    expect(input.allStepsStuck).toBe(false)
  })

  it("sets allStepsStuck from repeated failure", () => {
    const input = buildEscalationInput({
      verifierOverall: "retry",
      attempt: 2,
      maxAttempts: 3,
      hasRetryableSteps: true,
      allStepsRepeatedFailure: true,
    })

    expect(input.allStepsStuck).toBe(true)
  })

  it("passes through timeout flag", () => {
    const input = buildEscalationInput({
      verifierOverall: "retry",
      attempt: 0,
      maxAttempts: 3,
      hasRetryableSteps: true,
      allStepsRepeatedFailure: false,
      timedOut: true,
    })

    expect(input.timedOut).toBe(true)
  })
})
