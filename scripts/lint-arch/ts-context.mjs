/**
 * TypeScript AST context — deterministic parse + module resolution.
 * One thought: doctrine edges are facts about the program, not text guesses.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import ts from "typescript"

/**
 * @param {string} tsconfigPath
 * @returns {{ options: ts.CompilerOptions, host: ts.ModuleResolutionHost }}
 */
export function loadCompilerOptions(tsconfigPath) {
  if (!existsSync(tsconfigPath)) {
    return {
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      host: ts.sys,
    }
  }
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(tsconfigPath),
  )
  return { options: parsed.options, host: ts.sys }
}

/**
 * @param {string} filePath
 * @returns {ts.SourceFile}
 */
export function parseSourceFile(filePath) {
  const text = readFileSync(filePath, "utf8")
  const kind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true, kind)
}

/**
 * Resolve a module specifier relative to importer using TS resolution.
 * @returns {string | null} absolute path of resolved file, or null
 */
export function resolveModule(importerFile, specifier, options, host) {
  const result = ts.resolveModuleName(specifier, importerFile, options, host)
  const resolved = result.resolvedModule?.resolvedFileName
  if (!resolved) return null
  // Ignore .d.ts from node_modules for in-package layer checks
  if (resolved.includes(`${"node_modules"}/`)) return null
  return resolve(resolved)
}

/**
 * Collect static import / export-from / side-effect import specifiers.
 * @param {ts.SourceFile} sourceFile
 * @returns {{ specifier: string, line: number, isTypeOnly: boolean, isSideEffect: boolean }[]}
 */
export function collectModuleSpecifiers(sourceFile) {
  /** @type {{ specifier: string, line: number, isTypeOnly: boolean, isSideEffect: boolean }[]} */
  const out = []

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      out.push({
        specifier: stmt.moduleSpecifier.text,
        line: sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1,
        isTypeOnly: !!stmt.importClause?.isTypeOnly,
        isSideEffect: !stmt.importClause,
      })
    }
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      out.push({
        specifier: stmt.moduleSpecifier.text,
        line: sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1,
        isTypeOnly: !!stmt.isTypeOnly,
        isSideEffect: false,
      })
    }
  }

  // `import("…").Type` / `typeof import("…")` — same layer/cycle edges as import decls.
  const visit = (node) => {
    if (ts.isImportTypeNode(node) && node.argument && ts.isLiteralTypeNode(node.argument)) {
      const lit = node.argument.literal
      if (ts.isStringLiteral(lit)) {
        out.push({
          specifier: lit.text,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          isTypeOnly: true,
          isSideEffect: false,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return out
}

/**
 * Line number (1-based) for a node.
 * @param {ts.SourceFile} sf
 * @param {ts.Node} node
 */
export function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/**
 * @param {string} pkgSrc
 * @param {string} absFile
 */
export function relToPkg(pkgSrc, absFile) {
  return relative(pkgSrc, absFile).split("\\").join("/")
}
