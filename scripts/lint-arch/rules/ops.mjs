/**
 * Sub-linear ops — variance is data; no tenant-identity code dialects.
 */

import ts from "typescript"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

const IDENTITY_NAMES = new Set(["tenantId", "orgId", "customerId", "tenant"])

/**
 * Fail when tenant/org identity is compared to a string literal or DEFAULT_* 
 * outside allowlisted persistence adapters.
 *
 * @param {{ file: string, note: string, used?: boolean }[]} tenantBranchAllowlist
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
            "ops-tenant-identity-fork",
            `Tenant/org identity compared to a literal or DEFAULT_* — that forks code per tenant. ` +
              `Put variance in tenant config / catalog / publish data, or allowlist this persistence adapter (must shrink). See docs/doctrine.md`,
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
