/**
 * Platform store boundary — driver / getDb stay inside persistence adapters.
 * Adapter tree: infra/persistence/adapters/{sqlite,mssql,pg}/
 */

import ts from "typescript"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import { collectModuleSpecifiers, lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

const ADAPTER_TREE = "infra/persistence/adapters/"
const ADAPTER_KINDS = new Set(["sqlite", "mssql", "pg"])

/**
 * @param {string} rel
 */
function isPlatformAdapterPath(rel) {
  if (!rel.startsWith(ADAPTER_TREE)) return false
  const rest = rel.slice(ADAPTER_TREE.length)
  const kind = rest.split("/")[0]
  return Boolean(kind && ADAPTER_KINDS.has(kind))
}

/**
 * @param {{ name: string, src: string }} pkg
 * @param {string[]} files
 */
export function lintPlatformStoreBoundary(pkg, files) {
  if (pkg.name !== "server") return

  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isPlatformAdapterPath(rel)) continue
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
          `better-sqlite3 must only be imported under ${ADAPTER_TREE}{sqlite,mssql,pg}/ (got ${rel}). Use repository functions via infra/persistence barrels.`,
        )
      }
      if (isConnectionModule(specifier)) {
        fail(
          file,
          line,
          "platform-store",
          `Do not import SQLite connection modules outside ${ADAPTER_TREE} (got ${rel}). Boot/CLI: adapters/sqlite/index.js (openDatabase); product code: repository functions.`,
        )
      }
      if (importsGetDbName(sf, specifier)) {
        fail(
          file,
          line,
          "platform-store",
          `getDb must not be imported outside ${ADAPTER_TREE} (got ${rel}).`,
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
          `getDb() calls must stay under ${ADAPTER_TREE}{sqlite,mssql,pg}/ (got ${rel}). Use repository functions.`,
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
    /(?:^|\/)infra\/persistence\/(?:adapters\/(?:sqlite|mssql|pg)\/)?(?:connection|db-connection)(?:\.js)?$/.test(
      specifier,
    ) || /(?:^|\/)adapters\/(?:sqlite|mssql|pg)\/(?:connection|db-connection)(?:\.js)?$/.test(specifier)
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
