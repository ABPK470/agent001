/**
 * Determinism + secret sanitization.
 */

import ts from "typescript"
import {
  DETERMINISTIC_LAYERS,
  SECRET_NAME_RE,
} from "../registry/policy.mjs"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

/**
 * Class 24 — no unseeded entropy in domain/core.
 */
export function lintDeterministicExecution(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const layer = rel.split("/")[0]
    if (!DETERMINISTIC_LAYERS.has(layer)) continue

    const sf = parseSourceFile(file)
    const visit = (node) => {
      // Math.random()
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Math" &&
        node.expression.name.text === "random"
      ) {
        fail(
          file,
          lineOf(sf, node),
          "deterministic-execution",
          `Math.random() in ${layer}/ — unseeded entropy. Inject an rng port. See docs/doctrine.md.`,
        )
      }
      // crypto.randomUUID() / crypto.getRandomValues(
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "randomUUID" ||
          node.expression.name.text === "getRandomValues")
      ) {
        fail(
          file,
          lineOf(sf, node),
          "deterministic-execution",
          `${node.expression.name.text}() in ${layer}/ — unseeded entropy. Inject an rng port. See docs/doctrine.md.`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/**
 * Class 25 — Object.keys / Map iteration that drives outcomes must be ordered.
 * Flags: for...of Object.keys(x) without .sort in the same expression.
 */
export function lintDeterministicOrdering(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const layer = rel.split("/")[0]
    if (!DETERMINISTIC_LAYERS.has(layer)) continue

    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (ts.isForOfStatement(node)) {
        const expr = node.expression
        if (isUnorderedObjectKeys(expr) || isBareMapOrSetIter(expr)) {
          fail(
            file,
            lineOf(sf, node),
            "deterministic-ordering",
            `Unordered iteration in ${layer}/ — sort keys (or Array.from(map.keys()).sort()) before iterating. See docs/doctrine.md.`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/** @param {ts.Expression} expr */
function isUnorderedObjectKeys(expr) {
  // Object.keys(x) without .sort()
  if (!ts.isCallExpression(expr)) return false
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Object" &&
    expr.expression.name.text === "keys"
  ) {
    return true
  }
  // Object.keys(x).sort() — OK
  return false
}

/** @param {ts.Expression} expr */
function isBareMapOrSetIter(expr) {
  // for (const x of someMap) where name ends with Map/Set — heuristic
  if (ts.isIdentifier(expr) && /(Map|Set)$/.test(expr.text)) return true
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.name) &&
    /(Map|Set)$/.test(expr.name.text)
  ) {
    return true
  }
  return false
}

/**
 * Class 27 — do not log secret-bearing properties.
 */
export function lintDataSanitization(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        ["log", "info", "warn", "error", "debug"].includes(node.expression.name.text) &&
        (node.expression.expression.text === "console" ||
          /log/i.test(node.expression.expression.text))
      ) {
        for (const arg of node.arguments) {
          if (argContainsSecretAccess(arg)) {
            fail(
              file,
              lineOf(sf, node),
              "data-sanitization",
              `Logging a secret-bearing property — redact before the sink. See docs/doctrine.md.`,
            )
            break
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/** @param {ts.Node} node */
function argContainsSecretAccess(node) {
  let hit = false
  const visit = (n) => {
    if (hit) return
    if (ts.isPropertyAccessExpression(n) && SECRET_NAME_RE.test(n.name.text)) {
      hit = true
      return
    }
    if (ts.isIdentifier(n) && SECRET_NAME_RE.test(n.text)) {
      // bare `password` identifier in log args
      hit = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return hit
}
