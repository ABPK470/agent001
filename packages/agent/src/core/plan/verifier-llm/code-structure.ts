/**
 * Deterministic code structure analysis — extracts imported names and
 * locally declared identifiers from a source file so the LLM verifier can
 * skip re-analyzing imports and refrain from flagging language keywords.
 *
 * @module
 */

const LANG_KEYWORDS: Record<string, Set<string>> = {
  js: new Set([
    "abstract",
    "arguments",
    "as",
    "async",
    "await",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "double",
    "else",
    "enum",
    "eval",
    "export",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "from",
    "function",
    "goto",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "int",
    "interface",
    "let",
    "long",
    "native",
    "new",
    "null",
    "of",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "var",
    "void",
    "volatile",
    "while",
    "with",
    "yield",
    "declare",
    "namespace",
    "module",
    "readonly",
    "keyof",
    "infer",
    "never",
    "unknown",
    "any",
    "object",
    "string",
    "number",
    "bigint",
    "symbol",
    "satisfies"
  ]),
  python: new Set([
    "False",
    "None",
    "True",
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield"
  ])
}

export interface CodeStructureAnalysis {
  language: string
  importedNames: string[]
  localDeclarations: string[]
  keywordsNote: string
}

export function analyzeCodeStructure(filePath: string, content: string): CodeStructureAnalysis | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  const isJS = ["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)
  const isPy = ext === "py"

  if (!isJS && !isPy) return null

  const keywords = isJS ? LANG_KEYWORDS.js : LANG_KEYWORDS.python
  const language = isJS ? (["ts", "tsx"].includes(ext) ? "TypeScript" : "JavaScript") : "Python"

  const importedNames: string[] = []

  if (isJS) {
    for (const m of content.matchAll(/^import\s+(\w+)\s+from\s+['"][^'"]+['"]/gm)) importedNames.push(m[1])
    for (const m of content.matchAll(/^import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
    for (const m of content.matchAll(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]+['"]/gm))
      importedNames.push(m[1])
    for (const m of content.matchAll(/const\s+(\w+)\s*=\s*require\s*\(/gm)) importedNames.push(m[1])
    for (const m of content.matchAll(/const\s+\{([^}]+)\}\s*=\s*require\s*\(/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
  }

  if (isPy) {
    for (const m of content.matchAll(/^from\s+\S+\s+import\s+(.+)/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
    for (const m of content.matchAll(/^import\s+(\w+)(?:\s+as\s+(\w+))?/gm))
      importedNames.push(m[2]?.trim() || m[1])
  }

  const localDeclarations: string[] = []
  if (isJS) {
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g))
      localDeclarations.push(m[1])
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/g))
      localDeclarations.push(m[1])
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+(\w+)/g)) localDeclarations.push(m[1])
    for (const m of content.matchAll(/const\s+\[(\w+)\s*,\s*(\w+)\]\s*=/g)) {
      localDeclarations.push(m[1], m[2])
    }
  }
  if (isPy) {
    for (const m of content.matchAll(/(?:^|\n)\s*(?:async\s+)?def\s+(\w+)/g)) localDeclarations.push(m[1])
    for (const m of content.matchAll(/(?:^|\n)\s*class\s+(\w+)/g)) localDeclarations.push(m[1])
  }

  const uniqueImported = [...new Set(importedNames.filter(Boolean))]
  const uniqueLocal = [...new Set(localDeclarations.filter(Boolean))]
  const keywordsNote =
    `${language} built-in keywords (e.g. ${[...keywords].slice(0, 8).join(", ")}, …) ` +
    `and runtime globals (e.g. console, process, window, …) are always defined — never "missing".`

  return { language, importedNames: uniqueImported, localDeclarations: uniqueLocal, keywordsNote }
}

export function wrapArtifactWithStructureAnalysis(filePath: string, content: string, sizeNote = ""): string {
  const analysis = analyzeCodeStructure(filePath, content)
  if (!analysis) {
    return `### ${filePath}\n${sizeNote}\`\`\`\n${content}\n\`\`\``
  }

  const preChecked = [
    `Language: ${analysis.language}`,
    `Imports (pre-verified): ${analysis.importedNames.length > 0 ? analysis.importedNames.join(", ") : "(none)"}`,
    `Local declarations (pre-verified): ${analysis.localDeclarations.length > 0 ? analysis.localDeclarations.join(", ") : "(none)"}`,
    `Keywords note: ${analysis.keywordsNote}`
  ].join("\n")

  return (
    `### ${filePath}\n` +
    (sizeNote ? sizeNote : "") +
    `<!-- pre-checked structure (do NOT re-analyze imports or flag keywords) -->\n` +
    `\`\`\`\nPRE-CHECKED STRUCTURE:\n${preChecked}\n\`\`\`\n` +
    `\`\`\`\n${content}\n\`\`\``
  )
}
