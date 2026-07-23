import { relative } from "node:path"

/** @typedef {{ file: string, line: number, rule: string, detail: string }} ArchError */

/** @type {ArchError[]} */
export const errors = []

export function fail(file, line, rule, detail) {
  errors.push({ file, line, rule, detail })
}

/** @param {string} root */
export function printReport(root) {
  if (errors.length === 0) return false
  console.error(`lint-arch: ${errors.length} violation(s):\n`)
  const grouped = new Map()
  for (const e of errors) {
    const key = relative(root, e.file)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(e)
  }
  for (const [file, items] of grouped) {
    console.error(`  ${file}`)
    for (const e of items) {
      const loc = e.line ? `L${e.line}` : "   "
      console.error(`    ${loc}  [${e.rule}]  ${e.detail}`)
    }
  }
  console.error(`\nDoctrine: docs/doctrine.md`)
  return true
}
