/**
 * Method reference integrity probes — detect this.method() calls without
 * matching definitions, bare helper calls without imports/definitions, and
 * potential use-before-declaration of const/let bindings.
 *
 * @module
 */

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
