/**
 * External Leverage runners — domain surface, mechanical sympathy, trust.
 */

import { existsSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import {
  DOMAIN_SURFACE_PREFIXES,
  SHARED_ENUMS_DIR,
} from "../registry/policy.mjs"
import {
  SURFACE_JARGON_PATTERNS,
  TRUST_DANGEROUS_SINKS,
  TRUST_PURE_LAYERS,
} from "../external.mjs"
import { fail } from "../report.mjs"
import { isTestFile, walk } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

function loadSharedEnumNames(root) {
  const dir = join(root, SHARED_ENUMS_DIR)
  /** @type {Set<string>} */
  const names = new Set()
  if (!existsSync(dir)) return names
  for (const file of walk(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    const sf = parseSourceFile(file)
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      if (!exported) continue
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text)
      }
    }
  }
  return names
}

/**
 * Domain surface: UI must not fork shared-enums const names; must not leak
 * internal jargon into widget/state string literals.
 */
export function lintDomainSurface(root, uiPkg, files, enumForkAllowlist, jargonAllowlist) {
  const enumNames = loadSharedEnumNames(root)

  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    const rel = relToPkg(uiPkg.src, file)
    if (isTestFile(rel)) continue
    const inSurface = DOMAIN_SURFACE_PREFIXES.some((p) => rel.startsWith(p))
    if (!inSurface) continue

    const sf = parseSourceFile(file)
    const repoRel = relative(root, file).split("\\").join("/")

    // Enum fork: export const SameNameAsSharedEnum = …
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      if (!exported) continue
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const name = decl.name.text
        if (!enumNames.has(name)) continue
        const debt = enumForkAllowlist.find((a) => a.file === repoRel && a.name === name)
        if (debt) {
          debt.used = true
          continue
        }
        fail(
          file,
          lineOf(sf, decl),
          "surface-enum-fork",
          `Exported "${name}" forks @mia/shared-enums vocabulary — import the shared enum (1:1 domain surface). ` +
            `Or add shrinking enumForkAllowlist debt. See docs/doctrine.md External Leverage.`,
        )
      }
    }

    // Jargon leak in string literals (user-facing surface layers)
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text
        for (const p of SURFACE_JARGON_PATTERNS) {
          if (!p.re.test(text)) continue
          const debt = jargonAllowlist.find(
            (a) => a.file === repoRel && a.pattern === p.id,
          )
          if (debt) {
            debt.used = true
            continue
          }
          fail(
            file,
            lineOf(sf, node),
            "surface-jargon",
            `User-facing surface leaks ${p.detail} ("${p.id}"). Keep the domain surface free of platform internals. ` +
              `See docs/doctrine.md External Leverage.`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/**
 * Mechanical sympathy: never silently swallow failures.
 * Empty catch / .catch(() => {}) hide durability and intent.
 */
export function lintSilentFailure(pkg, files, silentAllowlist) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const repoRel = `${pkg.name}/${rel}`

    const sf = parseSourceFile(file)
    let hits = 0

    const visit = (node) => {
      // catch { } / catch (e) { }
      if (ts.isCatchClause(node)) {
        const block = node.block
        if (block.statements.length === 0) {
          hits++
          reportSilent(file, sf, node, repoRel, silentAllowlist, "empty catch block")
        }
      }

      // .catch(() => {}) or .catch(() => undefined)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (node.expression.name.text === "catch" && node.arguments.length >= 1) {
          const arg = node.arguments[0]
          if (isEmptyHandler(arg)) {
            hits++
            reportSilent(file, sf, node, repoRel, silentAllowlist, "empty .catch(() => {})")
          }
        }
      }

      ts.forEachChild(node, visit)
    }
    visit(sf)

    if (hits > 0) {
      for (const a of silentAllowlist) {
        if (a.file === repoRel || a.file === `packages/${repoRel}`) a.used = true
      }
    }
  }
}

function reportSilent(file, sf, node, repoRel, silentAllowlist, kind) {
  const debt = silentAllowlist.find(
    (a) => a.file === repoRel || a.file === `packages/${repoRel}`,
  )
  if (debt) {
    debt.used = true
    return
  }
  fail(
    file,
    lineOf(sf, node),
    "sympathy-silent-failure",
    `${kind} — mechanical sympathy requires named handling (log, surface error, or typed recovery). ` +
      `Silent swallow loses user intent and state. Allowlist only with a burn-down note. See docs/doctrine.md.`,
  )
}

/** @param {ts.Expression} arg */
function isEmptyHandler(arg) {
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return false
  const body = arg.body
  if (ts.isBlock(body)) return body.statements.length === 0
  // () => undefined / () => null / () => void 0
  if (ts.isIdentifier(body) && (body.text === "undefined" || body.text === "null")) return true
  if (body.kind === ts.SyntaxKind.VoidExpression) return true
  return false
}

/**
 * Trust: no type escapes in pure layers; no eval/Function; no @ts-ignore;
 * no dangerouslySetInnerHTML without allowlist.
 */
export function lintTrustHygiene(pkg, files, trustAllowlist) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const layer = rel.split("/")[0]
    const repoRel = `${pkg.name}/${rel}`
    const sf = parseSourceFile(file)
    const text = sf.getFullText()

    // Directives only in comments (not string literals that mention @ts-ignore)
    const commentRanges = [
      ...(ts.getLeadingCommentRanges(text, 0) ?? []),
      ...collectAllCommentRanges(sf, text),
    ]
    for (const range of commentRanges) {
      const c = text.slice(range.pos, range.end)
      if (/@ts-(ignore|nocheck)\b/.test(c)) {
        if (!matchTrustDebt(trustAllowlist, repoRel, "ts-directive")) {
          fail(
            file,
            sf.getLineAndCharacterOfPosition(range.pos).line + 1,
            "trust-ts-escape",
            `@ts-ignore / @ts-nocheck disables correctness. Fix the type or allowlist with burn-down note.`,
          )
        }
      }
      if (TRUST_PURE_LAYERS.has(layer) && /@ts-expect-error\b/.test(c)) {
        if (!matchTrustDebt(trustAllowlist, repoRel, "ts-expect-error")) {
          fail(
            file,
            sf.getLineAndCharacterOfPosition(range.pos).line + 1,
            "trust-ts-escape",
            `@ts-expect-error in ${layer}/ — pure layers must be honest types. Allowlist only while burning down.`,
          )
        }
      }
    }

    const visit = (node) => {
      // as any
      if (
        TRUST_PURE_LAYERS.has(layer) &&
        ts.isAsExpression(node) &&
        node.type.kind === ts.SyntaxKind.AnyKeyword
      ) {
        if (!matchTrustDebt(trustAllowlist, repoRel, "as-any")) {
          fail(
            file,
            lineOf(sf, node),
            "trust-as-any",
            `"as any" in ${layer}/ erases invariants. Narrow the type or allowlist with burn-down note.`,
          )
        }
      }

      // eval / new Function
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        for (const sink of TRUST_DANGEROUS_SINKS) {
          if (sink.match(node.expression.text) && !matchTrustDebt(trustAllowlist, repoRel, sink.id)) {
            fail(
              file,
              lineOf(sf, node),
              "trust-dangerous-sink",
              `${sink.id}() breaks integrity boundaries. Forbidden unless allowlisted.`,
            )
          }
        }
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Function"
      ) {
        if (!matchTrustDebt(trustAllowlist, repoRel, "Function")) {
          fail(
            file,
            lineOf(sf, node),
            "trust-dangerous-sink",
            `new Function() breaks integrity boundaries. Forbidden unless allowlisted.`,
          )
        }
      }

      // dangerouslySetInnerHTML
      if (
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "dangerouslySetInnerHTML"
      ) {
        if (!matchTrustDebt(trustAllowlist, repoRel, "dangerouslySetInnerHTML")) {
          fail(
            file,
            lineOf(sf, node),
            "trust-dangerous-sink",
            `dangerouslySetInnerHTML is an XSS sink — use safe rendering or allowlist with review note.`,
          )
        }
      }

      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

function matchTrustDebt(list, repoRel, kind) {
  const a = list.find((x) => (x.file === repoRel || x.file === `packages/${repoRel}`) && x.kind === kind)
  if (a) {
    a.used = true
    return true
  }
  return false
}

/** @param {ts.SourceFile} sf @param {string} text */
function collectAllCommentRanges(sf, text) {
  /** @type {ts.CommentRange[]} */
  const out = []
  const visit = (node) => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ]
    out.push(...ranges)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
