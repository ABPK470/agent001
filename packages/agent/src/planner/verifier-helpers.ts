/**
 * Verifier helpers — LLM response parsing, fallback decisions, gibberish detection,
 * code corruption detection, method reference integrity, evidence helpers.
 *
 * Extracted from verifier.ts.
 *
 * @module
 */

import type { VerifierDecision, VerifierOutcome, VerifierStepAssessment } from "./types.js"

// ============================================================================
// LLM verification parsing
// ============================================================================

export function parseLLMVerification(
  raw: string,
  fallbackAssessments: readonly VerifierStepAssessment[],
): VerifierDecision {
  let jsonStr = raw.trim()
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1].trim()
  }

  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>

    const steps: VerifierStepAssessment[] = Array.isArray(obj.steps)
      ? (obj.steps as Array<Record<string, unknown>>).map(s => {
          const rawIssues: string[] = Array.isArray(s.issues) ? s.issues.map(String) : []
          const cleanIssues = rawIssues.filter(i => !isLLMGibberish(i))

          return {
            stepName: String(s.stepName ?? ""),
            outcome: parseOutcome(s.outcome),
            confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
            issues: cleanIssues,
            retryable: Boolean(s.retryable ?? true),
          }
        })
      : [...fallbackAssessments]

    return {
      overall: parseOutcome(obj.overall),
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
      steps,
      unresolvedItems: Array.isArray(obj.unresolvedItems) ? obj.unresolvedItems.map(String) : [],
    }
  } catch {
    return buildFallbackDecision(fallbackAssessments)
  }
}

export function parseOutcome(value: unknown): VerifierOutcome {
  const s = String(value ?? "")
  if (s === "pass" || s === "retry" || s === "fail") return s
  return "pass"
}

export function buildFallbackDecision(
  assessments: readonly VerifierStepAssessment[],
): VerifierDecision {
  const anyFail = assessments.some(a => a.outcome === "fail")
  const anyRetry = assessments.some(a => a.outcome === "retry")
  const allIssues = assessments.flatMap(a => a.issues)

  return {
    overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
    confidence: Math.min(1.0, ...assessments.map(a => a.confidence)),
    steps: [...assessments],
    unresolvedItems: allIssues,
  }
}

// ============================================================================
// Gibberish detection
// ============================================================================

export function computeGibberishScore(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0)
  if (words.length < 5) return 0

  let score = 0
  const wordCount = words.length

  const compoundJargon = text.match(/[a-z]+-[a-z]+-[a-z]+/gi) ?? []
  if (compoundJargon.length >= 2) score += 0.3

  const functionWordRe = /\b(the|is|a|an|and|to|of|in|for|with|that|was|were|has|have|it|this|are)\b/gi
  const functionWordCount = (text.match(functionWordRe) ?? []).length
  const functionWordRatio = functionWordCount / wordCount
  if (functionWordRatio === 0 && wordCount >= 8) score += 0.4
  else if (functionWordRatio < 0.05) score += 0.3

  const sentenceEnders = (text.match(/[.!?]\s/g) ?? []).length + (text.endsWith(".") || text.endsWith("!") || text.endsWith("?") ? 1 : 0)
  if (sentenceEnders === 0 && wordCount >= 8) score += 0.2

  const hasCodeIndicators = /[/\\]|\.(?:js|ts|html|css|py)\b|`[^`]+`|\bfunction\b|\bclass\b|\bconst\b/i.test(text)
  if (!hasCodeIndicators && wordCount >= 8) score += 0.2

  return Math.min(1, score)
}

export function isLLMGibberish(issue: string): boolean {
  const words = issue.split(/\s+/).filter(w => w.length > 0)
  if (words.length < 8) return false

  let score = 0

  const compoundCount = (issue.match(/[a-z]+-[a-z]+-[a-z]+/gi) ?? []).length
  if (compoundCount >= 3) score += 0.4
  else if (compoundCount >= 2) score += 0.2

  const functionWords = (issue.match(/\b(the|is|a|an|and|to|of|in|for|with|that|was|it|this|are|not|but|be|has|have|can|does|should|must)\b/gi) ?? []).length
  const ratio = functionWords / words.length
  if (ratio < 0.04 && words.length >= 15) score += 0.4
  else if (ratio < 0.06 && words.length >= 12) score += 0.2

  const hasCodeRefs = /[/\\]|\.(?:js|ts|html|css|py)\b|`[^`]+`|\bfunction\b|\bclass\b|\bconst\b|\bread_file\b|\bwrite_file\b|\breplace_in_file\b|\bstub\b|\bplaceholder\b/i.test(issue)
  if (!hasCodeRefs && words.length >= 10) score += 0.2

  const sentenceEnders = (issue.match(/[.!?]\s/g) ?? []).length + (issue.endsWith(".") || issue.endsWith("!") || issue.endsWith("?") ? 1 : 0)
  if (sentenceEnders === 0 && words.length >= 12) score += 0.1

  return score >= 0.6
}

// ============================================================================
// Code corruption / LLM degeneration detection
// ============================================================================

const SOURCE_LIKE_PATH_RE =
  /(?:^|\/)(?:src|lib|app|server|client|cmd|pkg|include|internal|tests?|spec)(?:\/|$)|\.(?:c|cc|cpp|cxx|h|hpp|rs|go|py|rb|php|java|kt|swift|cs|js|jsx|ts|tsx|json|toml|yaml|yml|xml|sh|zsh|bash)$/i

export function detectCodeCorruption(code: string): string[] {
  const findings: string[] = []
  const lines = code.split("\n")

  const brokenCodeRe = /[})\]]\s*[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i
  let brokenLineCount = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length > 10 && brokenCodeRe.test(trimmed)) {
      if (!trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("#")) {
        brokenLineCount++
      }
    }
  }
  if (brokenLineCount > 0) {
    findings.push(`${brokenLineCount} line(s) with code-mixed-with-gibberish (LLM degeneration)`)
  }

  const nonsenseTokenRe = /\b[a-z]+(?:\/[a-z])+\b/gi
  const nonsenseMatches = code.match(nonsenseTokenRe) ?? []
  const suspiciousNonsense = nonsenseMatches.filter(m =>
    !SOURCE_LIKE_PATH_RE.test(m) && m.length > 3
  )
  if (suspiciousNonsense.length >= 2) {
    findings.push(`Suspicious word/symbol fragments: "${suspiciousNonsense.slice(0, 3).join('", "')}"`)
  }

  const lastMeaningfulLine = lines.filter(l => l.trim().length > 0).pop()?.trim() ?? ""
  if (
    code.length > 100 &&
    lastMeaningfulLine.length > 0 &&
    !lastMeaningfulLine.endsWith("}") &&
    !lastMeaningfulLine.endsWith(";") &&
    !lastMeaningfulLine.endsWith(")") &&
    !lastMeaningfulLine.endsWith("*/") &&
    !lastMeaningfulLine.endsWith("`") &&
    !/^(?:export|module\.exports|\/\/)/i.test(lastMeaningfulLine)
  ) {
    const opens = (code.match(/{/g) ?? []).length
    const closes = (code.match(/}/g) ?? []).length
    if (opens > closes + 1) {
      findings.push(`File appears truncated/corrupted: ${opens - closes} unclosed brace(s), ends with "${lastMeaningfulLine.slice(-60)}"`)
    }
  }

  return findings
}

export function detectHtmlCorruption(html: string): string[] {
  const findings: string[] = []

  const corruptAttrRe = /\w+="[^"]*[{};][^"]*"/g
  const corruptAttrs = html.match(corruptAttrRe) ?? []
  const suspiciousAttrs = corruptAttrs.filter(a => {
    if (/^style="/i.test(a)) return false
    return true
  })
  if (suspiciousAttrs.length > 0) {
    findings.push(`Corrupted HTML attribute(s): ${suspiciousAttrs.slice(0, 3).map(a => `"${a.slice(0, 60)}"`).join(", ")}`)
  }

  const unclosedAttrRe = /\w+="[^"]{10,}(?:>|\n|$)/gm
  const unclosedAttrs = html.match(unclosedAttrRe) ?? []
  if (unclosedAttrs.length > 0) {
    findings.push(`Unclosed HTML attribute value(s): ${unclosedAttrs.slice(0, 3).map(a => `"${a.trim().slice(0, 60)}"`).join(", ")}`)
  }

  const unclosedTagRe = /<\w+[^>]*(?:\n[^>]*){5,}/g
  if (unclosedTagRe.test(html)) {
    findings.push("HTML tag spans 5+ lines without closing — possible degeneration")
  }

  const scriptBlocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) ?? []
  for (const block of scriptBlocks) {
    const inner = block.replace(/<\/?script[^>]*>/gi, "")
    const corruption = detectCodeCorruption(inner)
    if (corruption.length > 0) {
      findings.push(`Embedded <script> has corrupted code: ${corruption[0]}`)
    }
  }

  return findings
}

// ============================================================================
// Method reference integrity
// ============================================================================

const BUILTIN_METHODS = new Set([
  "toString", "valueOf", "hasOwnProperty", "constructor",
  "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill",
  "map", "filter", "reduce", "forEach", "find", "findIndex", "some", "every",
  "includes", "indexOf", "lastIndexOf", "flat", "flatMap", "slice", "concat", "join",
  "toLowerCase", "toUpperCase", "trim", "split", "replace", "match", "startsWith",
  "endsWith", "includes", "charAt", "substring", "padStart", "padEnd",
  "add", "delete", "has", "get", "set", "clear", "keys", "values", "entries",
  "addEventListener", "removeEventListener", "querySelector", "querySelectorAll",
  "getElementById", "getElementsByClassName", "createElement", "appendChild",
  "removeChild", "setAttribute", "getAttribute", "classList", "dispatchEvent",
  "preventDefault", "stopPropagation",
  "bind", "call", "apply", "then", "catch", "finally", "emit", "on", "off",
  "log", "warn", "error", "info",
])

const RESERVED_CALL_IDENTIFIERS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "new", "delete", "void",
  "function", "class", "super", "this", "await", "yield", "import", "export", "default",
  "require", "console", "document", "window", "globalThis", "Math", "JSON", "Object", "Array",
  "String", "Number", "Boolean", "Date", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol",
  "RegExp", "Error", "URL", "fetch", "parseInt", "parseFloat", "isNaN", "isFinite", "setTimeout",
  "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "addEventListener", "removeEventListener", "querySelector", "querySelectorAll", "getElementById",
  "createElement", "alert", "confirm", "prompt",
])

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function detectUnresolvedMethods(code: string): string[] {
  const callRe = /this\.([a-zA-Z_$]\w*)\s*\(/g
  const calls = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = callRe.exec(code)) !== null) {
    calls.add(m[1])
  }

  const definitions = new Set<string>()
  const methodRe = /^\s*(?:async\s+)?([a-zA-Z_$]\w*)\s*\(/gm
  while ((m = methodRe.exec(code)) !== null) {
    if (m[1]) definitions.add(m[1])
  }
  const accessorRe = /^\s*(?:get|set)\s+([a-zA-Z_$]\w*)\s*\(/gm
  while ((m = accessorRe.exec(code)) !== null) {
    if (m[1]) definitions.add(m[1])
  }
  const funcDeclRe = /function\s+([a-zA-Z_$]\w*)\s*\(/g
  while ((m = funcDeclRe.exec(code)) !== null) {
    if (m[1]) definitions.add(m[1])
  }
  const constFuncRe = /(?:const|let|var)\s+([a-zA-Z_$]\w*)\s*=\s*(?:function|\([^)]*\)\s*=>)/g
  while ((m = constFuncRe.exec(code)) !== null) {
    if (m[1]) definitions.add(m[1])
  }

  const unresolved: string[] = []
  for (const call of calls) {
    if (!definitions.has(call) && !BUILTIN_METHODS.has(call)) {
      unresolved.push(`this.${call}() called but not defined in file`)
    }
  }
  return unresolved.slice(0, 5)
}

export function detectUnresolvedBareHelpers(code: string): string[] {
  const definitions = new Set<string>()
  const imports = new Set<string>()

  const functionDeclRe = /function\s+([a-zA-Z_$]\w*)\s*\(/g
  const classDeclRe = /class\s+([a-zA-Z_$]\w*)\b/g
  const variableDeclRe = /(?:const|let|var)\s+([a-zA-Z_$]\w*)\s*=/g
  const methodLikeRe = /(^|\n)\s*(?:export\s+)?(?:async\s+)?([a-zA-Z_$]\w*)\s*\([^)]*\)\s*\{/g
  const importNamedRe = /import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g
  const importDefaultRe = /import\s+([a-zA-Z_$]\w*)(?:\s*,\s*\{[^}]+\})?\s*from\s*["'][^"']+["']/g
  const importNamespaceRe = /import\s+\*\s+as\s+([a-zA-Z_$]\w*)\s+from\s*["'][^"']+["']/g

  let match: RegExpExecArray | null
  while ((match = functionDeclRe.exec(code)) !== null) definitions.add(match[1])
  while ((match = classDeclRe.exec(code)) !== null) definitions.add(match[1])
  while ((match = variableDeclRe.exec(code)) !== null) definitions.add(match[1])
  while ((match = methodLikeRe.exec(code)) !== null) {
    const name = match[2]
    if (name && !RESERVED_CALL_IDENTIFIERS.has(name)) definitions.add(name)
  }
  while ((match = importNamedRe.exec(code)) !== null) {
    const entries = match[1].split(",")
    for (const entry of entries) {
      const localName = entry.split(/\s+as\s+/i).pop()?.trim()
      if (localName) imports.add(localName)
    }
  }
  while ((match = importDefaultRe.exec(code)) !== null) imports.add(match[1])
  while ((match = importNamespaceRe.exec(code)) !== null) imports.add(match[1])

  const unresolved: string[] = []
  const bareCallRe = /([a-zA-Z_$]\w*)\s*\(/g
  while ((match = bareCallRe.exec(code)) !== null) {
    const name = match[1]
    if (!name) continue
    const prevChar = code[Math.max(0, match.index - 1)]
    if (prevChar && /[.\w$]/.test(prevChar)) continue
    if (definitions.has(name) || imports.has(name) || RESERVED_CALL_IDENTIFIERS.has(name) || BUILTIN_METHODS.has(name)) continue

    const before = code.slice(Math.max(0, match.index - 24), match.index + name.length + 1)
    if (/(?:function|class|new|if|for|while|switch|catch)\s+$/.test(before)) continue

    const issue = `${name}() called but not defined or imported in file`
    if (!unresolved.includes(issue)) unresolved.push(issue)
  }

  return unresolved.slice(0, 5)
}

export function detectPotentialUseBeforeDeclaration(code: string): string[] {
  const issues: string[] = []
  const lines = code.split("\n")
  const declarations = new Map<string, number>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const match of line.matchAll(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$]\w*)\b/gm)) {
      const name = match[1]
      if (name && !declarations.has(name)) declarations.set(name, i)
    }
  }

  for (const [name, declLine] of declarations) {
    for (let i = 0; i < declLine; i++) {
      const line = lines[i]
      if (/^\s*(?:\/\/|\*)/.test(line)) continue
      const re = new RegExp(`(^|[^.\\w$])${escapeRegExp(name)}(?=[^\\w$]|$)`)
      const m = re.exec(line)
      if (!m) continue
      if (m[1] === "'" || m[1] === '"' || m[1] === "`") continue
      if (new RegExp(`\b(?:const|let|var|function|class)\s+${escapeRegExp(name)}\b`).test(line)) continue
      issues.push(`${name} is referenced before its const/let declaration (line ${i + 1} before line ${declLine + 1})`)
      break
    }
  }

  return issues.slice(0, 5)
}


export * from "./verifier-helpers-dom.js"
