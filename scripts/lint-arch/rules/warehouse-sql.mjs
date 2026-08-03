/**
 * Warehouse / dialect SQL ownership — high-signal T-SQL tokens stay out of
 * Sync domain/ports (and Sync core except known cutover modules).
 *
 * Full extract to adapters/{mssql,postgres}/dialect/** is the next milestone;
 * runtime/** and listed core cutover files remain owners until then.
 */

import { readFileSync } from "node:fs"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import { relToPkg } from "../ts-context.mjs"

/** @type {RegExp[]} */
const DIALECT_SQL_PATTERNS = [
  /\bHASHBYTES\s*\(/i,
  /\bMERGE\s+/i,
  /\bSET\s+IDENTITY_INSERT\b/i,
  /\bsys\.(columns|tables|triggers|objects|foreign_keys)\b/i,
  /#syncSrc\b/,
  /\bWITH\s*\(\s*NOLOCK\s*\)/i,
]

/**
 * Sync paths that may still contain warehouse dialect SQL until extract.
 * @param {string} rel
 */
function isSyncDialectOwner(rel) {
  if (rel.startsWith("adapters/")) return true
  // Runtime still owns catalog-drift / search NOLOCK / conflict probes until later extracts.
  if (rel.startsWith("runtime/")) return true
  return false
}

/** Strip comments + string/template literals so capability names don't false-positive. */
function codeWithoutLiterals(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
}

/**
 * @param {{ name: string, src: string }} pkg
 * @param {string[]} files
 */
export function lintWarehouseSqlOwnership(pkg, files) {
  if (pkg.name !== "sync") return

  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    if (isSyncDialectOwner(rel)) continue

    const code = codeWithoutLiterals(readFileSync(file, "utf8"))

    for (const pattern of DIALECT_SQL_PATTERNS) {
      const m = pattern.exec(code)
      if (!m) continue
      const idx = m.index
      const line = code.slice(0, idx).split("\n").length
      fail(
        file,
        line,
        "warehouse-sql",
        `Dialect SQL (${pattern.source}) must live under adapters/** or runtime/** until WarehouseDialect extract (got ${rel}).`,
      )
      break
    }
  }
}
