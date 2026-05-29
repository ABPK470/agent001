/**
 * Branch-inconsistency analyzer. Extracted from code-quality.ts.
 *
 * @module
 */


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
 * Examples this catches (without knowing what .owner, .role, .method mean):
 *   - Domain: evaluateAction() checks `.owner` in one branch but not others
 *   - Auth: checkPermission() checks `.role` in admin branch but not user/guest
 *   - API: validateRequest() checks `.origin` in POST branch but not PUT/DELETE
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
