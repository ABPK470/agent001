/**
 * Sub-linear ops — variance is data; no tenant-identity code dialects.
 */

import ts from "typescript"
import { IDENTITY_NAMES } from "../registry/policy.mjs"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

/**
 * Fail when configured identity names are compared to literals / DEFAULT_*.
 */
export function lintTenantIdentityForks(pkg, files, tenantBranchAllowlist) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue

    const debt = tenantBranchAllowlist.find((a) => a.file === `${pkg.name}/${rel}` || a.file === rel)
    if (debt) {
      // Still scan — mark used if any identity fork found; always mark if listed
      debt.used = true
      continue
    }

    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
      ) {
        if (isIdentityComparedToLiteral(node.left, node.right) || isIdentityComparedToLiteral(node.right, node.left)) {
          fail(
            file,
            lineOf(sf, node),
            "identity-literal-fork",
            `Identity compared to a literal or DEFAULT_* — that forks code per tenant. ` +
              `Put variance in config/catalog data — tenant code forks are forbidden.`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/** @param {ts.Expression} a @param {ts.Expression} b */
function isIdentityComparedToLiteral(a, b) {
  if (!isIdentityExpr(a)) return false
  if (ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b)) return true
  if (ts.isIdentifier(b) && /^DEFAULT_/.test(b.text)) return true
  if (ts.isPropertyAccessExpression(b) && ts.isIdentifier(b.name) && /^DEFAULT_/.test(b.name.text)) {
    return true
  }
  return false
}

/** @param {ts.Expression} expr */
function isIdentityExpr(expr) {
  if (ts.isIdentifier(expr) && IDENTITY_NAMES.has(expr.text)) return true
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return IDENTITY_NAMES.has(expr.name.text)
  }
  return false
}

/** Fail unused entries in a debt allowlist array. */
export function lintStaleDebtList(list, rule, label) {
  for (const a of list) {
    if (a.used) continue
    fail(
      a.file ?? "lint-arch",
      0,
      rule,
      `Unused ${label} allowlist entry (${a.file ?? a.surface ?? a.key ?? "?"}): ${a.note ?? ""}. Remove it — allowlists must shrink.`,
    )
  }
}

/**
 * Class 19 — allowlist creep is closed: debt lists must stay empty.
 * Soft-ignore is not enforcement.
 */
export function lintDebtListsEmpty(lists) {
  for (const { list, label } of lists) {
    if (!list?.length) continue
    fail(
      "lint-arch",
      0,
      "allowlist-creep",
      `${label} has ${list.length} debt entr${list.length === 1 ? "y" : "ies"} — allowlists must stay empty. Fix the code; do not soft-ignore.`,
    )
  }
}
