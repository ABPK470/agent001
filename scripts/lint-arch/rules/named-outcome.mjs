/**
 * Class 13 — named outcomes over silent fallbacks.
 * Decision functions must not catch-and-return a bare null/undefined/literal
 * without a discriminant property (named outcome object).
 */

import ts from "typescript"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

const DECISION_NAME =
  /^(decide|choose|assess|resolve|route|select|pick|gate|classify)[A-Z_]/

/**
 * @param {{ name: string, src: string }} pkg
 * @param {string[]} files
 * @param {string[]} layers e.g. ["core"] — only scan these layer roots
 */
export function lintNamedOutcomes(pkg, files, layers = ["core"]) {
  const layerSet = new Set(layers)
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const layer = rel.split("/")[0]
    if (!layerSet.has(layer)) continue

    const sf = parseSourceFile(file)
    const visit = (node, inDecision) => {
      let next = inDecision
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        DECISION_NAME.test(node.name.text)
      ) {
        next = true
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        DECISION_NAME.test(node.name.text) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        next = true
      }

      if (next && ts.isCatchClause(node)) {
        checkCatchReturnsNamedOutcome(file, sf, node)
      }

      ts.forEachChild(node, (child) => visit(child, next))
    }
    visit(sf, false)
  }
}

/** @param {ts.CatchClause} catchClause */
function checkCatchReturnsNamedOutcome(file, sf, catchClause) {
  const block = catchClause.block
  for (const stmt of block.statements) {
    if (!ts.isReturnStatement(stmt) || !stmt.expression) continue
    const expr = stmt.expression
    if (isBareFallback(expr)) {
      fail(
        file,
        lineOf(sf, stmt),
        "named-outcome",
        `Decision-path catch returns a bare fallback (${expr.getText(sf)}). ` +
          `Return a named outcome object (discriminant field) or rethrow. See docs/doctrine.md.`,
      )
    }
  }
  // Empty catch in decision function = silent swallow of outcome path
  if (block.statements.length === 0) {
    fail(
      file,
      lineOf(sf, catchClause),
      "named-outcome",
      `Decision-path empty catch — silent outcome fallback. Name the failure or rethrow.`,
    )
  }
}

/** @param {ts.Expression} expr */
function isBareFallback(expr) {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return true
  if (ts.isIdentifier(expr) && (expr.text === "undefined" || expr.text === "null")) return true
  if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr)) return true
  if (ts.isPrefixUnaryExpression(expr)) return true // !x, void 0
  if (
    ts.isVoidExpression(expr) ||
    (ts.isAsExpression(expr) && isBareFallback(expr.expression))
  ) {
    return true
  }
  // { ok: false } style is named — allow object literals with properties
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length > 0) return false
  if (ts.isObjectLiteralExpression(expr)) return true
  return false
}
