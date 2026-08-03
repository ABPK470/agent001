#!/usr/bin/env node
/**
 * Mechanical cutover: sync schema/execute → execute-async in listed files.
 * - Swaps imports and call sites to run*Async / upsert*Async
 * - Marks functions/methods that gained `await` as async
 * - Converts getPlatformStore().transaction(() => …) → transactionAsync(async () => …)
 *
 * Usage: node scripts/async-cutover-execute.mjs <file> [<file>…]
 */
import { readFileSync, writeFileSync } from "node:fs"

const SYNC_FNS = ["runAll", "runGet", "runExec", "runChanges", "runInsertId"]
const UPSERT_FNS = ["upsertRow", "insertRowOrIgnore", "getRowByKeys"]

function rewrite(source) {
  let s = source

  // execute.js imports → execute-async.js with Async names
  s = s.replace(
    /import\s*\{([^}]+)\}\s*from\s*(["'])([^"']*schema\/execute\.js)\2/g,
    (full, body, q, path) => {
      const names = body.split(",").map((p) => p.trim()).filter(Boolean)
      const mapped = names.map((n) => {
        const m = n.match(/^([A-Za-z0-9_]+)(\s+as\s+[A-Za-z0-9_]+)?$/)
        if (!m) return n
        const base = m[1]
        if (SYNC_FNS.includes(base)) return `${base}Async${m[2] ?? ""}`
        if (base === "type" || n.startsWith("type ")) return n
        if (base === "CompiledQuery" || n.includes("CompiledQuery")) return n
        return n
      })
      const newPath = path.replace(/execute\.js$/, "execute-async.js")
      // Keep CompiledQuery type from execute.js if present
      const hasType = names.some((n) => n.includes("CompiledQuery"))
      if (hasType) {
        const valueImports = mapped.filter((n) => !n.includes("CompiledQuery"))
        const typeImports = names.filter((n) => n.includes("CompiledQuery"))
        const lines = []
        if (valueImports.length) {
          lines.push(`import { ${valueImports.join(", ")} } from ${q}${newPath}${q}`)
        }
        lines.push(`import { ${typeImports.join(", ")} } from ${q}${path}${q}`)
        return lines.join("\n")
      }
      return `import { ${mapped.join(", ")} } from ${q}${newPath}${q}`
    },
  )

  // upsert imports — add Async suffix to named imports
  s = s.replace(
    /import\s*\{([^}]+)\}\s*from\s*(["'])([^"']*schema\/upsert\.js)\2/g,
    (full, body, q, path) => {
      const names = body.split(",").map((p) => p.trim()).filter(Boolean)
      const mapped = names.map((n) => {
        const m = n.match(/^([A-Za-z0-9_]+)(\s+as\s+[A-Za-z0-9_]+)?$/)
        if (!m) return n
        const base = m[1]
        if (UPSERT_FNS.includes(base)) return `${base}Async${m[2] ?? ""}`
        return n
      })
      return `import { ${mapped.join(", ")} } from ${q}${path}${q}`
    },
  )

  for (const fn of SYNC_FNS) {
    const re = new RegExp(`(?<!\\w)${fn}\\s*\\(`, "g")
    s = s.replace(re, `await ${fn}Async(`)
  }
  for (const fn of UPSERT_FNS) {
    const re = new RegExp(`(?<!\\w)${fn}\\s*\\(`, "g")
    s = s.replace(re, `await ${fn}Async(`)
  }

  // Avoid double-await / double-Async
  s = s.replace(/await await /g, "await ")
  s = s.replace(/AsyncAsync/g, "Async")
  s = s.replace(/await (run\w+AsyncAsync)\(/g, "await $1(".replace("AsyncAsync", "Async"))
  // Fix botched double: await runAllAsyncAsync(
  s = s.replace(/await (run(?:All|Get|Exec|Changes|InsertId))AsyncAsync\(/g, "await $1Async(")
  s = s.replace(
    /await (upsertRow|insertRowOrIgnore|getRowByKeys)AsyncAsync\(/g,
    "await $1Async(",
  )

  // transaction → transactionAsync
  s = s.replace(
    /getPlatformStore\(\)\.transaction\(\(\)\s*=>/g,
    "await getPlatformStore().transactionAsync(async () =>",
  )

  // Mark export function / function that contain await as async
  // Process from bottom to top by finding function declarations
  const lines = s.split("\n")
  const awaitLineIdx = []
  for (let i = 0; i < lines.length; i++) {
    if (/\bawait\b/.test(lines[i])) awaitLineIdx.push(i)
  }

  function findEnclosingFnStart(lineIdx) {
    let depth = 0
    for (let i = lineIdx; i >= 0; i--) {
      const line = lines[i]
      // crude brace counting from current up
      for (const ch of line) {
        if (ch === "}") depth++
        if (ch === "{") depth--
      }
      if (depth < 0) {
        // crossed into a block start on this line — not reliable
      }
      const m = line.match(
        /^(\s*)(export\s+)?(async\s+)?(function\s+[A-Za-z0-9_]+|const\s+[A-Za-z0-9_]+\s*=\s*(async\s*)?\()/,
      )
      if (m && !m[0].includes("async")) {
        // verify this function actually contains our await (brace match)
        return i
      }
      if (m && m[0].includes("async")) return -1
    }
    return -1
  }

  // Simpler: for each "export function name" / "function name" without async,
  // if body contains await, add async.
  const fnStarts = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/)
    if (m && !lines[i].includes("async function")) {
      fnStarts.push(i)
    }
  }
  for (const start of fnStarts) {
    // find matching closing brace at indent level
    let depth = 0
    let started = false
    let end = start
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") {
          depth++
          started = true
        } else if (ch === "}") {
          depth--
        }
      }
      end = i
      if (started && depth === 0) break
    }
    const body = lines.slice(start, end + 1).join("\n")
    if (/\bawait\b/.test(body)) {
      lines[start] = lines[start].replace(
        /^(\s*)(export\s+)?function\s+/,
        (_, sp, exp) => `${sp}${exp ?? ""}async function `,
      )
    }
  }

  s = lines.join("\n")
  return s
}

const files = process.argv.slice(2)
if (!files.length) {
  console.error("Usage: node scripts/async-cutover-execute.mjs <file…>")
  process.exit(1)
}
for (const file of files) {
  const before = readFileSync(file, "utf8")
  if (!before.includes("schema/execute.js") && !before.includes("schema/upsert.js")) {
    console.log(`skip (no execute/upsert import): ${file}`)
    continue
  }
  const after = rewrite(before)
  if (after === before) {
    console.log(`unchanged: ${file}`)
    continue
  }
  writeFileSync(file, after)
  console.log(`updated: ${file}`)
}
