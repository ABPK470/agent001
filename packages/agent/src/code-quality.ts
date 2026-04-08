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

// ============================================================================
// Placeholder / stub patterns
// ============================================================================

/** Patterns that indicate skeleton / placeholder code that is not real implementation. */
export const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Explicit stubs — keyword can appear ANYWHERE in the comment, not just at the start.
  // LLMs write "// Basic legal move logic placeholder" or "// Handle X (placeholder for now)".
  { re: /\/\/.*\b(?:placeholder|todo|fixme|implement|stub)\b/gi, label: "placeholder comment" },
  { re: /\/\*[^*]*\b(?:placeholder|todo|fixme|implement|stub)\b/gi, label: "placeholder comment" },
  { re: /#.*\b(?:placeholder|todo|fixme|implement|stub)\b/gi, label: "placeholder comment" },
  // "TO BE IMPLEMENTED" / "TO BE ADDED" / "NOT YET IMPLEMENTED" deferred stubs
  { re: /\/\/\s*(?:\w+\s+)*(?:to\s+be\s+implemented|to\s+be\s+added|not\s+yet\s+implemented)\b/gi, label: "stub comment" },
  // LLM degeneration: references "existing" code instead of writing it
  // Catches: "// Other code as per existing logic", "// existing implementation",
  // "// rest of the code here", "// same as above", "// code continues as before", "// ... remaining"
  { re: /\/\/\s*(?:other|rest\s+of(?:\s+the)?|remaining)\s+(?:code|logic|implementation)\b/gi, label: "degeneration comment (references code that should be written)" },
  { re: /\/\/\s*(?:existing|previous|prior)\s+(?:code|logic|implementation)\b/gi, label: "degeneration comment (references code that should be written)" },
  { re: /\/\/\s*(?:same|similar|code continues?)\s+(?:as\s+)?(?:above|before|previously|existing)\b/gi, label: "degeneration comment (references code that should be written)" },
  { re: /\/\/\s*(?:as\s+per|as\s+in)\s+(?:existing|previous|above|the\s+original)\b/gi, label: "degeneration comment (references code that should be written)" },
  { re: /\/\/\s*\.{3}\s*(?:remaining|rest|other|more)\b/gi, label: "degeneration comment (elided code)" },
  // Trivially-returning validation functions — both `function` declarations AND class methods
  {
    re: /function\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+)\s*\([^)]*\)\s*\{[\s\n]*return\s+(true|false)\s*;?\s*\}/gi,
    label: "validation function always returns constant",
  },
  // Class method variant: `isLegalMove(...) { return true; }` (no `function` keyword)
  {
    re: /^\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+|get\w+Legal\w*|on\w+)\s*\([^)]*\)\s*\{[\s\n]*return\s+(true|false)\s*;?\s*\}/gim,
    label: "stub method always returns constant",
  },
  // Validation/compute functions with a comment then trivial return
  {
    re: /function\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+|get\w+)\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*|\/\*[^*]*\*\/[\s\n]*)+return\s+(true|false|\[\]|\{\}|null|undefined|0|"")\s*;?\s*\}/gi,
    label: "stub function (comment + trivial return)",
  },
  // Class method with comment then trivial return: `isLegalMove(...) { // placeholder\n return true; }`
  {
    re: /^\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+|get\w+|on\w+|handle\w+)\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*|\/\*[^*]*\*\/[\s\n]*)+return\s+(true|false|\[\]|\{\}|null|undefined|0|"")\s*;?\s*\}/gim,
    label: "stub method (comment + trivial return)",
  },
  // Functions whose ENTIRE body is `/* comment */ return [];` or `return {};`
  {
    re: /function\s+\w+\s*\([^)]*\)\s*\{[\s\n]*(?:\/\*[^*]*\*\/[\s\n]*|\/\/[^\n]*[\s\n]*)*(return\s+\[\]\s*;?)\s*\}/gi,
    label: "stub function returns empty array",
  },
  {
    re: /function\s+\w+\s*\([^)]*\)\s*\{[\s\n]*(?:\/\*[^*]*\*\/[\s\n]*|\/\/[^\n]*[\s\n]*)*(return\s+\{\}\s*;?)\s*\}/gi,
    label: "stub function returns empty object",
  },
  // Arrow function variant
  {
    re: /(?:const|let|var)\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+)\s*=\s*\([^)]*\)\s*=>\s*(true|false)\s*;?/gi,
    label: "validation function always returns constant",
  },
  // Arrow function returning empty array/object stub
  {
    re: /(?:const|let|var)\s+\w+\s*=\s*\([^)]*\)\s*=>\s*(\[\]|\{\})\s*;?/gi,
    label: "arrow function returns empty array/object stub",
  },
  // Console.log-only function — a function/method whose only non-comment statement is console.log()
  // This is a de facto stub event handler: `onSquareClick(row, col) { console.log(...); }`
  // Negative lookahead excludes JS keywords (if, for, while, etc.) to prevent false positives.
  {
    re: /(?:function\s+\w+|^\s+(?!if\b|for\b|while\b|switch\b|do\b|catch\b|else\b|return\b|throw\b|new\b|typeof\b|try\b|class\b|const\b|let\b|var\b)\w+)\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*)*console\.log\([^)]*\)\s*;?[\s\n]*\}/gim,
    label: "console.log-only function (stub event handler)",
  },
  // Empty function bodies — both declarations and class methods
  {
    re: /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:function|\([^)]*\)\s*=>))\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*)*\}/gi,
    label: "empty function body",
  },
  // Class method empty body: `  methodName(...) { }` or `  methodName(...) { // comment }`
  // Negative lookahead excludes JS keywords to avoid matching `if (...) {}` as empty methods.
  {
    re: /^\s+(?!if\b|for\b|while\b|switch\b|do\b|catch\b|else\b|return\b|throw\b|new\b|typeof\b|try\b|class\b|const\b|let\b|var\b)\w+\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*)*\}/gim,
    label: "empty method body",
  },
]

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
    let lo = 0, hi = lineStarts.length - 1
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
  const deferredRe = /\/\/\s*(?:\w+\s+)*(?:will\s+(?:go|be\s+(?:added|implemented|handled))|goes?\s+here|add(?:ed)?\s+(?:later|here))\b/gi
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
  const funcRe = /(?:function\s+|^\s+)(validate\w*|check\w*|is[A-Z]\w*|can[A-Z]\w*|isValid\w*|isLegal\w*|getLegal\w*|calculate\w*|compute\w*|get[A-Z]\w*|find[A-Z]\w*|handle[A-Z]\w*|on[A-Z]\w*)\s*\(/gm
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
        if (depth === 0) { bodyEnd = i; break }
      }
    }
    if (bodyEnd < 0) continue
    const body = code.slice(bodyStart + 1, bodyEnd)
    const bodyLines = body.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"))
    if (bodyLines.length < 3) continue

    const lastLine = bodyLines[bodyLines.length - 1]
    if (/^return\s+true\s*;?\s*$/.test(lastLine)) {
      const hasBranches = /\b(?:if|switch|case)\b/.test(body)
      if (hasBranches) {
        const hasExhaustiveLoop = /\bfor\s*\(/.test(body)
        if (!hasExhaustiveLoop && bodyLines.length < 10) {
          findings.push(`catch-all "return true" in ${funcName}() — handles some cases but falls through to true for the rest`)
        }
      }
    }
  }
  return findings
}

// ============================================================================
// Structural logic analysis — catches "looks complete but is broken"
// ============================================================================

/**
 * Helper: extract the body of a function (brace-matched).
 * Returns null if the body can't be found.
 */
function extractFunctionBody(code: string, startOffset: number): { body: string; bodyStart: number; bodyEnd: number } | null {
  const bodyStart = code.indexOf("{", startOffset)
  if (bodyStart < 0) return null
  let depth = 0
  let bodyEnd = -1
  for (let i = bodyStart; i < code.length; i++) {
    if (code[i] === "{") depth++
    else if (code[i] === "}") {
      depth--
      if (depth === 0) { bodyEnd = i; break }
    }
  }
  if (bodyEnd < 0) return null
  return { body: code.slice(bodyStart + 1, bodyEnd), bodyStart, bodyEnd }
}

/**
 * Detect multi-branch dispatch functions with inconsistent predicate checks.
 *
 * Generic structural analysis — zero domain-specific knowledge.
 *
 * Finds ANY function with ≥3 if/else-if branches that return true, where a
 * "same-property comparison" (`.prop op .prop` with the same property name
 * on both sides) appears in SOME branches but not ALL.  This indicates a
 * cross-cutting concern (ownership, role, permission, type) that was applied
 * to only a subset of branches — a structural inconsistency regardless of domain.
 *
 * Examples this catches (without knowing what .color, .role, .method mean):
 *   - Game:  isValidMove() checks `.color` in pawn branch but not rook/knight/bishop
 *   - Auth:  checkPermission() checks `.role` in admin branch but not user/guest
 *   - API:   validateRequest() checks `.origin` in POST branch but not PUT/DELETE
 *
 * The detector also recognises a global guard before the dispatch chain:
 *   if (target.prop === source.prop) return false;
 * When such a guard exists the per-branch check is unnecessary → no finding.
 */
export function detectInconsistentBranches(code: string): string[] {
  const findings: string[] = []

  // Match ALL named functions AND class methods — no name-pattern filter
  const funcRe = /(?:function\s+|^\s+)(\w+)\s*\(/gm
  let m: RegExpExecArray | null

  // Same-property comparison: `.PROP op .PROP` where PROP is identical on both sides.
  // The backreference \1 ensures the property name matches.
  // Excludes | and & to avoid matching across `||`/`&&` boundaries
  // (e.g. `x.sym === 'a' || x.sym === 'b'` should NOT match).
  // e.g. `.color !== piece.color`, `.role === user.role`, `.team != other.team`
  const propPairRe = /\.(\w+)\s*(?:!==|===|!=|==)\s*[^;{}\n|&]*\.\1\b/

  while ((m = funcRe.exec(code)) !== null) {
    const funcName = m[1]!
    const result = extractFunctionBody(code, m.index + m[0].length)
    if (!result) continue
    const { body } = result

    // Need ≥3 total branches (1 if + ≥2 else-if)
    const elseIfs = body.match(/\}\s*else\s+if\s*\(/g)
    if (!elseIfs || elseIfs.length < 2) continue

    // Split into branches and check each one that returns true
    const branches = body.split(/\}\s*else\s+if\s*\(/)
    let branchesWithPairCheck = 0
    let branchesWithReturnTrue = 0
    let detectedProp = ''

    for (const branch of branches) {
      if (/return\s+true\b/.test(branch)) {
        branchesWithReturnTrue++
        const pairMatch = propPairRe.exec(branch)
        if (pairMatch) {
          branchesWithPairCheck++
          if (!detectedProp) detectedProp = pairMatch[1]!
        }
      }
    }

    // Need substantial dispatch, and inconsistency (some but not all)
    if (branchesWithReturnTrue < 3) continue
    if (branchesWithPairCheck === 0 || branchesWithPairCheck === branchesWithReturnTrue) continue

    // Check for a global guard before the dispatch chain:
    //   if (x.PROP === y.PROP) return false
    // Uses backreference to match any property name generically.
    const firstElseIfIdx = body.search(/\}\s*else\s+if\s*\(/)
    if (firstElseIfIdx >= 0) {
      const preBranch = body.slice(0, firstElseIfIdx)
      const guardRe = /if\s*\([^{}]*?\.(\w+)\s*===\s*[^{}]*?\.\1[^{}]*\)\s*return\s+false/
      if (guardRe.test(preBranch)) continue // global guard exists → ok
    }

    findings.push(
      `inconsistent branch logic in ${funcName}(): ` +
      `${branchesWithPairCheck}/${branchesWithReturnTrue} branches ` +
      `check .${detectedProp} equality — remaining branches omit this check, ` +
      `which may allow invalid state transitions`,
    )
  }

  return findings
}
