/**
 * Module import / export extraction utilities. Extracted from helpers.ts.
 *
 * @module
 */

export interface ModuleImportRef {
  readonly specifier: string
  readonly importedNames: readonly string[]
  readonly defaultImport?: string
  readonly namespaceImport?: string
}

export function extractModuleImports(code: string): ModuleImportRef[] {
  const imports: ModuleImportRef[] = []
  const importFromRe = /import\s+([^;\n]+?)\s+from\s+["']([^"']+)["']/g
  const sideEffectImportRe = /import\s+["']([^"']+)["']/g
  const exportFromRe = /export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g
  const exportAllFromRe = /export\s+\*\s+from\s+["']([^"']+)["']/g
  const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g

  let match: RegExpExecArray | null
  while ((match = importFromRe.exec(code)) !== null) {
    const clause = (match[1] ?? "").trim()
    const specifier = match[2]
    const importedNames: string[] = []
    let defaultImport: string | undefined
    let namespaceImport: string | undefined

    if (clause.startsWith("{")) {
      importedNames.push(...parseNamedImports(clause))
    } else if (clause.startsWith("* as ")) {
      namespaceImport = clause.replace(/^\*\s+as\s+/, "").trim()
    } else if (clause.includes(",")) {
      const [first, second] = clause.split(",", 2)
      defaultImport = first.trim() || undefined
      const rest = second.trim()
      if (rest.startsWith("{")) importedNames.push(...parseNamedImports(rest))
      if (rest.startsWith("* as ")) namespaceImport = rest.replace(/^\*\s+as\s+/, "").trim()
    } else {
      defaultImport = clause.trim() || undefined
    }

    imports.push({ specifier, importedNames, defaultImport, namespaceImport })
  }

  while ((match = sideEffectImportRe.exec(code)) !== null) {
    const specifier = match[1]
    if (
      !imports.some(
        (entry) =>
          entry.specifier === specifier &&
          entry.importedNames.length === 0 &&
          !entry.defaultImport &&
          !entry.namespaceImport
      )
    ) {
      imports.push({ specifier, importedNames: [] })
    }
  }

  while ((match = exportFromRe.exec(code)) !== null) {
    imports.push({ specifier: match[2], importedNames: parseNamedImports(`{${match[1]}}`) })
  }

  while ((match = exportAllFromRe.exec(code)) !== null) {
    imports.push({ specifier: match[1], importedNames: [] })
  }

  while ((match = dynamicImportRe.exec(code)) !== null) {
    imports.push({ specifier: match[1], importedNames: [] })
  }

  return imports
}

function parseNamedImports(clause: string): string[] {
  const body = clause.replace(/^\{/, "").replace(/\}$/, "")
  return body
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+as\s+/i)[0]?.trim() ?? "")
    .filter(Boolean)
}

export function extractModuleExports(code: string): { named: Set<string>; hasDefault: boolean } {
  const named = new Set<string>()
  let hasDefault = false

  const exportFunctionRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$]\w*)\s*\(/g
  const exportClassRe = /export\s+class\s+([A-Za-z_$]\w*)\b/g
  const exportDeclRe = /export\s+(?:const|let|var)\s+([A-Za-z_$]\w*)\b/g
  const exportNamedRe = /export\s+\{([^}]+)\}/g
  const exportDefaultRe = /export\s+default\b/g

  let match: RegExpExecArray | null
  while ((match = exportFunctionRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportClassRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportDeclRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportNamedRe.exec(code)) !== null) {
    for (const entry of match[1].split(",")) {
      const localName = entry.split(/\s+as\s+/i)[0]?.trim()
      if (localName) named.add(localName)
    }
  }
  while (exportDefaultRe.exec(code) !== null) hasDefault = true

  return { named, hasDefault }
}
