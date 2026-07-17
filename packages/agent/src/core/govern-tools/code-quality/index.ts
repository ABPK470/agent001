/**
 * Code quality detection — shared between write_file (real-time) and verifier (post-pipeline).
 *
 * These detectors scan source code for placeholder / stub patterns and catch-all
 * returns. They are used in two places:
 *
 *   1. **write_file tool** — immediate feedback when the child writes a file,
 *      so stubs are caught at the point of action (not after the child finishes).
 *
 *   2. **Verifier deterministic probes** — post-pipeline check for any remaining
 *      stubs the child didn't fix.
 *
 * @module
 */

import { PLACEHOLDER_PATTERNS } from "./patterns.js"
import { detectInconsistentBranches } from "./branch-analysis.js"
export { PLACEHOLDER_PATTERNS } from "./patterns.js"
export { detectInconsistentBranches } from "./branch-analysis.js"

// ============================================================================
// Detection functions
// ============================================================================

/**
 * Scan source code for placeholder / stub patterns.
 * Returns a list of human-readable findings with function names and line numbers
 * so feedback is precise and actionable.
 */
export function detectPlaceholderPatterns(code: string): string[] {
  const findings: string[] = []

  // Precompute line starts for O(log n) line number lookup
  const lineStarts: number[] = [0]
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") lineStarts.push(i + 1)
  }
  const getLineNumber = (offset: number): number => {
    let lo = 0,
      hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1 // 1-indexed
  }

  for (const { re, label } of PLACEHOLDER_PATTERNS) {
    re.lastIndex = 0
    const matchDetails: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      // Extract function name from match text
      const fnMatch = m[0].match(/function\s+(\w+)|(?:const|let|var)\s+(\w+)/)
      const fnName = fnMatch?.[1] || fnMatch?.[2] || null
      const lineNum = getLineNumber(m.index)
      matchDetails.push(fnName ? `${fnName}() (line ${lineNum})` : `line ${lineNum}`)
      if (matchDetails.length >= 15) break
    }
    if (matchDetails.length > 0) {
      findings.push(`${label}: ${matchDetails.join(", ")}`)
    }
    if (findings.length >= 8) break
  }

  // ── Catch-all return detection ──
  const catchAllFindings = detectCatchAllReturns(code)
  for (const f of catchAllFindings) {
    if (findings.length >= 8) break
    findings.push(f)
  }

  // ── Structural: inconsistent branch logic (generic, domain-agnostic) ──
  const branchFindings = detectInconsistentBranches(code)
  for (const f of branchFindings) {
    if (findings.length >= 8) break
    findings.push(f)
  }

  // ── "will go here" / "will be added" deferred-work comments ──
  const deferredRe =
    /\/\/\s*(?:\w+\s+)*(?:will\s+(?:go|be\s+(?:added|implemented|handled))|goes?\s+here|add(?:ed)?\s+(?:later|here))\b/gi
  deferredRe.lastIndex = 0
  const matchDetails: string[] = []
  let dm: RegExpExecArray | null
  while ((dm = deferredRe.exec(code)) !== null) {
    matchDetails.push(`line ${getLineNumber(dm.index)}`)
    if (matchDetails.length >= 10) break
  }
  if (matchDetails.length > 0 && findings.length < 8) {
    findings.push(`deferred-work comment: ${matchDetails.join(", ")}`)
  }

  return findings
}

/**
 * Detect validation/check functions that end with a catch-all `return true`.
 * These are functions with names like `validate*`, `check*`, `isValid*`, `canMove*`
 * that have some conditional logic but then fall through to `return true` for
 * unhandled cases — the classic stub disguise.
 */
export function detectCatchAllReturns(code: string): string[] {
  const findings: string[] = []
  // Match both `function` declarations AND class method syntax (indented, no `function` keyword).
  // Class methods: `  isLegalMove(start, end) {` — indented name, followed by parens and brace.
  const funcRe =
    /(?:function\s+|^\s+)(validate\w*|check\w*|is[A-Z]\w*|can[A-Z]\w*|isValid\w*|isLegal\w*|getLegal\w*|calculate\w*|compute\w*|get[A-Z]\w*|find[A-Z]\w*|handle[A-Z]\w*|on[A-Z]\w*)\s*\(/gm
  let m: RegExpExecArray | null
  while ((m = funcRe.exec(code)) !== null) {
    const funcName = m[1]
    const bodyStart = code.indexOf("{", m.index + m[0].length)
    if (bodyStart < 0) continue
    // Simple brace-matching to find function body
    let depth = 0
    let bodyEnd = -1
    for (let i = bodyStart; i < code.length; i++) {
      if (code[i] === "{") depth++
      else if (code[i] === "}") {
        depth--
        if (depth === 0) {
          bodyEnd = i
          break
        }
      }
    }
    if (bodyEnd < 0) continue
    const body = code.slice(bodyStart + 1, bodyEnd)
    const bodyLines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"))
    if (bodyLines.length < 3) continue

    const lastLine = bodyLines[bodyLines.length - 1]
    if (/^return\s+true\s*;?\s*$/.test(lastLine)) {
      const hasBranches = /\b(?:if|switch|case)\b/.test(body)
      if (hasBranches) {
        // Both `for` and `while` loops are exhaustive traversal patterns.
        // A `while (row !== to.row || col !== to.col)` path-check loop is
        // just as complete as a for-loop variant — must not be flagged.
        const hasExhaustiveLoop = /\b(?:for|while)\s*\(/.test(body)
        // Count distinct non-builtin function calls in the body.
        // If the function delegates to 3+ helpers, it's doing real work — not a stub.
        const builtins = new Set([
          "if",
          "for",
          "while",
          "switch",
          "return",
          "new",
          "typeof",
          "catch",
          "throw",
          "delete",
          "void",
          "Math",
          "console",
          "String",
          "Number",
          "Boolean",
          "Array",
          "Object",
          "JSON",
          "parseInt",
          "parseFloat",
          "isNaN",
          "isFinite"
        ])
        const callMatches = body.match(/\b([a-zA-Z_]\w*)\s*\(/g) || []
        const trailingParen = /\s*\($/
        const helperCalls = new Set(
          callMatches.map((c) => c.replace(trailingParen, "").trim()).filter((n) => !builtins.has(n))
        )
        const hasManyHelpers = helperCalls.size >= 3
        if (!hasExhaustiveLoop && !hasManyHelpers && bodyLines.length < 20) {
          findings.push(
            `catch-all "return true" in ${funcName}() — handles some cases but falls through to true for the rest`
          )
        }
      }
    }
  }
  return findings
}

// ============================================================================
// Structural logic analysis — catches "looks complete but is broken"
