/**
 * Warehouse / dialect SQL ownership — high-signal T-SQL tokens stay out of
 * Sync domain/ports/core and most of runtime. Owners are adapters/** only
 * (plus a short cutover allowlist for remaining runtime SQL).
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
  /\bsys\.(columns|tables|triggers|objects|foreign_keys|indexes|schemas)\b/i,
  /#syncSrc\b/,
  /\bWITH\s*\(\s*NOLOCK\s*\)/i,
]

/**
 * Remaining runtime files that still embed dialect SQL (TOP/COUNT_BIG, archive
 * triggers, contract-deploy). Shrink this list as extract continues.
 * @type {Set<string>}
 */
const RUNTIME_CUTOVER_OWNERS = new Set([
  "runtime/orchestrator/archive.ts",
  "runtime/orchestrator/flow/contract-deploy.ts",
])

/**
 * @param {string} rel
 */
function isSyncDialectOwner(rel) {
  if (rel.startsWith("adapters/")) return true
  if (RUNTIME_CUTOVER_OWNERS.has(rel)) return true
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
        `Dialect SQL (${pattern.source}) must live under adapters/** (got ${rel}).`,
      )
      break
    }
  }
}
