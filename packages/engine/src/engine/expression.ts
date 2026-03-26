/**
 * Expression engine — resolves dynamic references in step inputs.
 *
 * Supports:
 *   {{input.fieldName}}              — workflow run input
 *   {{steps.stepId.output.fieldName}} — output from a previous step
 *   {{steps.stepId.status}}           — status of a previous step
 *
 * Conditions (used for step.condition):
 *   {{input.amount}} > 1000
 *   {{steps.validate.output.valid}} == true
 *
 * This keeps workflows declarative: business users write expressions,
 * the engine resolves them at runtime.
 */

import { ExpressionError } from "../domain/errors.js";
import type { WorkflowRun } from "../domain/models.js";

export interface ExpressionContext {
  input: Record<string, unknown>
  steps: Record<string, { output: Record<string, unknown>; status: string }>
}

/** Build an ExpressionContext from a live run. */
export function buildContext(run: WorkflowRun): ExpressionContext {
  const steps: ExpressionContext["steps"] = {}
  for (const step of run.steps) {
    steps[step.definitionId] = { output: step.output, status: step.status }
  }
  return { input: run.input, steps }
}

/** Resolve all `{{...}}` expressions in a value tree, returning a new tree. */
export function resolveExpressions(
  value: unknown,
  ctx: ExpressionContext,
): unknown {
  if (typeof value === "string") {
    return resolveString(value, ctx)
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveExpressions(v, ctx))
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveExpressions(v, ctx)
    }
    return out
  }
  return value
}

/** Evaluate a condition expression. Returns true if the step should run. */
export function evaluateCondition(
  expr: string,
  ctx: ExpressionContext,
): boolean {
  const resolved = resolveString(expr, ctx)
  if (typeof resolved === "boolean") return resolved
  if (typeof resolved === "string") {
    return evaluateComparison(resolved)
  }
  return Boolean(resolved)
}

// ── internals ────────────────────────────────────────────────────

const EXPR_PATTERN = /\{\{(.+?)\}\}/g

function resolveString(value: string, ctx: ExpressionContext): unknown {
  // If the entire string is a single expression, return the raw value (preserve type)
  const fullMatch = /^\{\{(.+?)\}\}$/.exec(value)
  if (fullMatch) {
    return resolvePath(fullMatch[1].trim(), ctx)
  }
  // Otherwise, interpolate into a string
  return value.replace(EXPR_PATTERN, (_, path: string) => {
    const resolved = resolvePath(path.trim(), ctx)
    return String(resolved ?? "")
  })
}

function resolvePath(path: string, ctx: ExpressionContext): unknown {
  const segments = path.split(".")
  let current: unknown = ctx

  for (const segment of segments) {
    if (current === null || current === undefined) {
      throw new ExpressionError(
        path,
        `cannot resolve segment '${segment}' — parent is ${current}`,
      )
    }
    if (typeof current !== "object") {
      throw new ExpressionError(
        path,
        `cannot resolve segment '${segment}' — parent is not object`,
      )
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function evaluateComparison(expr: string): boolean {
  // Try to match: <left> <op> <right>
  const match = /^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/.exec(expr.trim())
  if (!match) {
    // No comparison operator — treat as truthy check
    return isTruthy(expr.trim())
  }

  const [, rawLeft, op, rawRight] = match
  const left = parseValue(rawLeft.trim())
  const right = parseValue(rawRight.trim())

  switch (op) {
    case "==":
      return left === right
    case "!=":
      return left !== right
    case ">":
      return Number(left) > Number(right)
    case "<":
      return Number(left) < Number(right)
    case ">=":
      return Number(left) >= Number(right)
    case "<=":
      return Number(left) <= Number(right)
    default:
      return false
  }
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true
  if (raw === "false") return false
  if (raw === "null" || raw === "undefined") return null
  const num = Number(raw)
  if (!Number.isNaN(num)) return num
  // Strip quotes
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  return raw
}

function isTruthy(val: string): boolean {
  if (
    val === "false" ||
    val === "0" ||
    val === "null" ||
    val === "undefined" ||
    val === ""
  ) {
    return false
  }
  return true
}
