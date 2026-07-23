/**
 * Lifecycle hardness — fire-and-forget, cancellation, host handles.
 */

import ts from "typescript"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

/**
 * Class 12 — void <call>() without .catch is dangling fire-and-forget.
 * void unusedVar (identifier) is fine.
 */
export function lintScopedLifecycle(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (!ts.isVoidExpression(node)) {
        ts.forEachChild(node, visit)
        return
      }
      const expr = node.expression
      // void foo().catch(...)  → CallExpression whose callee is .catch
      if (ts.isCallExpression(expr) && !isCatchCall(expr)) {
        fail(
          file,
          lineOf(sf, node),
          "scoped-lifecycle",
          `void <call>() without .catch — dangling fire-and-forget. ` +
            `Name the failure (.catch) or supervise the task. See docs/doctrine.md.`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/** @param {ts.CallExpression} call */
function isCatchCall(call) {
  return (
    ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "catch"
  )
}

/**
 * Class 13 — fetch() must pass AbortSignal.
 */
export function lintCancellationFlow(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "fetch"
      ) {
        if (!fetchHasSignal(node)) {
          fail(
            file,
            lineOf(sf, node),
            "cancellation-flow",
            `fetch() without AbortSignal — unaborted subpath. Pass signal from the parent. See docs/doctrine.md.`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/** @param {ts.CallExpression} call */
function fetchHasSignal(call) {
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "signal") {
        return true
      }
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "signal") return true
    }
  }
  return false
}

/**
 * Class 14 — setInterval must clearInterval in the same enclosing function.
 */
export function lintResourceCleanup(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    if (pkg.timerAllowlist?.has(rel)) continue
    const sf = parseSourceFile(file)
    const visit = (node, fnStack) => {
      let next = fnStack
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) {
        next = [...fnStack, node]
      }

      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "setInterval"
      ) {
        const owner = next[next.length - 1]
        if (owner && !mentionsClearInterval(owner)) {
          fail(
            file,
            lineOf(sf, node),
            "resource-cleanup",
            `setInterval without clearInterval in the same function — leakable host handle. ` +
              `Own the handle and clear on dispose. See docs/doctrine.md.`,
          )
        }
      }

      ts.forEachChild(node, (child) => visit(child, next))
    }
    visit(sf, [])
  }
}

/** @param {ts.Node} fnNode */
function mentionsClearInterval(fnNode) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "clearInterval"
    ) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(fnNode)
  return found
}
