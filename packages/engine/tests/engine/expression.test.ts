import { describe, expect, it } from "vitest"
import { StepStatus } from "../../src/domain/enums.js"
import { ExpressionError } from "../../src/domain/errors.js"
import {
    buildContext,
    evaluateCondition,
    resolveExpressions,
    type ExpressionContext,
} from "../../src/engine/expression.js"

function ctx(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    input: { name: "alice", amount: 500, flag: true },
    steps: {
      fetch: {
        output: { data: [1, 2, 3], total: 3 },
        status: StepStatus.Completed,
      },
      validate: { output: { valid: true }, status: StepStatus.Completed },
    },
    ...overrides,
  }
}

describe("resolveExpressions", () => {
  it("resolves input references", () => {
    const result = resolveExpressions("{{input.name}}", ctx())
    expect(result).toBe("alice")
  })

  it("resolves step output references", () => {
    const result = resolveExpressions("{{steps.fetch.output.total}}", ctx())
    expect(result).toBe(3)
  })

  it("resolves step status", () => {
    const result = resolveExpressions("{{steps.fetch.status}}", ctx())
    expect(result).toBe("completed")
  })

  it("preserves type for single expression", () => {
    const result = resolveExpressions("{{input.flag}}", ctx())
    expect(result).toBe(true)
  })

  it("interpolates multiple expressions into a string", () => {
    const result = resolveExpressions(
      "Hello {{input.name}}, total={{steps.fetch.output.total}}",
      ctx(),
    )
    expect(result).toBe("Hello alice, total=3")
  })

  it("recursively resolves objects", () => {
    const input = {
      url: "https://api.example.com/{{input.name}}",
      count: "{{steps.fetch.output.total}}",
    }
    const result = resolveExpressions(input, ctx()) as Record<string, unknown>
    expect(result["url"]).toBe("https://api.example.com/alice")
    expect(result["count"]).toBe(3)
  })

  it("recursively resolves arrays", () => {
    const input = ["{{input.name}}", "{{input.amount}}"]
    const result = resolveExpressions(input, ctx())
    expect(result).toEqual(["alice", 500])
  })

  it("passes through non-expression values", () => {
    expect(resolveExpressions(42, ctx())).toBe(42)
    expect(resolveExpressions(null, ctx())).toBeNull()
    expect(resolveExpressions(true, ctx())).toBe(true)
  })

  it("throws on unresolvable path", () => {
    expect(() =>
      resolveExpressions("{{steps.missing.output.x}}", ctx()),
    ).toThrow(ExpressionError)
  })
})

describe("evaluateCondition", () => {
  it("greater-than comparison", () => {
    expect(evaluateCondition("{{input.amount}} > 100", ctx())).toBe(true)
    expect(evaluateCondition("{{input.amount}} > 1000", ctx())).toBe(false)
  })

  it("equality comparison", () => {
    expect(evaluateCondition("{{input.name}} == alice", ctx())).toBe(true)
    expect(evaluateCondition("{{input.name}} != alice", ctx())).toBe(false)
  })

  it("boolean resolution", () => {
    expect(evaluateCondition("{{input.flag}}", ctx())).toBe(true)
    expect(evaluateCondition("{{steps.validate.output.valid}}", ctx())).toBe(
      true,
    )
  })

  it("less-than and >=, <=", () => {
    expect(evaluateCondition("{{input.amount}} < 1000", ctx())).toBe(true)
    expect(evaluateCondition("{{input.amount}} >= 500", ctx())).toBe(true)
    expect(evaluateCondition("{{input.amount}} <= 500", ctx())).toBe(true)
    expect(evaluateCondition("{{input.amount}} <= 499", ctx())).toBe(false)
  })

  it("falsy string values return false", () => {
    expect(evaluateCondition("false", { input: {}, steps: {} })).toBe(false)
    expect(evaluateCondition("0", { input: {}, steps: {} })).toBe(false)
    expect(evaluateCondition("null", { input: {}, steps: {} })).toBe(false)
  })
})

describe("buildContext", () => {
  it("builds context from a run", () => {
    const run = {
      id: "r1",
      workflowId: "w1",
      input: { x: 1 },
      status: "running" as const,
      steps: [
        {
          id: "sid",
          definitionId: "s1",
          name: "S1",
          action: "a",
          input: {},
          condition: null,
          onError: "fail" as const,
          status: StepStatus.Completed,
          order: 0,
          output: { y: 2 },
          error: null,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      ],
      createdAt: new Date(),
      completedAt: null,
    }
    const c = buildContext(run)
    expect(c.input).toEqual({ x: 1 })
    expect(c.steps["s1"]).toEqual({ output: { y: 2 }, status: "completed" })
  })
})
