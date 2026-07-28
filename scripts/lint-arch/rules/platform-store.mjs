/**
 * Platform store boundary — getDb / better-sqlite3 stay inside the SQLite adapter.
 */

import ts from "typescript"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import { collectModuleSpecifiers, lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

const ADAPTER_PREFIX = "infra/persistence/adapters/sqlite/"

/**
 * @param {{ name: string, src: string }} pkg
 * @param {string[]} files
 */
export function lintPlatformStoreBoundary(pkg, files) {
  if (pkg.name !== "server") return

  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (rel.startsWith(ADAPTER_PREFIX)) continue
    // Harness may import getDb / better-sqlite3 from the adapter for setup.
    if (isTestFile(rel)) continue

    const sf = parseSourceFile(file)

    for (const { specifier, line, isTypeOnly } of collectModuleSpecifiers(sf)) {
      if (isTypeOnly) continue
      if (specifier === "better-sqlite3" || specifier.startsWith("better-sqlite3/")) {
        fail(
          file,
          line,
          "platform-store",
          `better-sqlite3 must only be imported under ${ADAPTER_PREFIX} (got ${rel}). Use repository functions via infra/persistence/sqlite.js.`,
        )
      }
      if (isConnectionModule(specifier)) {
        fail(
          file,
          line,
          "platform-store",
          `Do not import SQLite connection modules outside ${ADAPTER_PREFIX} (got ${rel}). Boot/CLI: adapters/sqlite/index.js (openDatabase); product code: repository functions.`,
        )
      }
      if (importsGetDbName(sf, specifier)) {
        fail(
          file,
          line,
          "platform-store",
          `getDb must not be imported outside ${ADAPTER_PREFIX} (got ${rel}).`,
        )
      }
    }

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "getDb"
      ) {
        fail(
          file,
          lineOf(sf, node),
          "platform-store",
          `getDb() calls must stay under ${ADAPTER_PREFIX} (got ${rel}). Use repository functions.`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/** @param {string} specifier */
function isConnectionModule(specifier) {
  return (
    /(?:^|\/)infra\/persistence\/(?:adapters\/sqlite\/)?(?:connection|db-connection)(?:\.js)?$/.test(
      specifier,
    ) || /(?:^|\/)adapters\/sqlite\/(?:connection|db-connection)(?:\.js)?$/.test(specifier)
  )
}

/** @param {ts.SourceFile} sf @param {string} specifier */
function importsGetDbName(sf, specifier) {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== specifier) continue
    if (!stmt.importClause?.namedBindings || !ts.isNamedImports(stmt.importClause.namedBindings)) {
      continue
    }
    if (stmt.importClause.namedBindings.elements.some((e) => e.name.text === "getDb")) return true
  }
  return false
}
