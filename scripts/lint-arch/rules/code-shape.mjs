import ts from "typescript"
import { fail } from "../report.mjs"
import {
  collectModuleSpecifiers,
  lineOf,
  parseSourceFile,
  relToPkg,
} from "../ts-context.mjs"

/**
 * Module-level mutable state + banned globals — AST statements only
 * (never matches strings / comments).
 */
export function lintModuleState(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (pkg.stateAllowlist.has(rel)) continue
    if (rel.startsWith("test-support/")) continue
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue

    const sf = parseSourceFile(file)
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        const flags = stmt.declarationList.flags
        const isLet = (flags & ts.NodeFlags.Let) !== 0
        const isConst = (flags & ts.NodeFlags.Const) !== 0
        if (isLet) {
          fail(
            file,
            lineOf(sf, stmt),
            `${pkg.name}-no-module-let`,
            `top-level "let" — state belongs on Host / RunContext (or doctrine allowlist)`,
          )
        } else if (!isConst) {
          fail(
            file,
            lineOf(sf, stmt),
            `${pkg.name}-no-module-var`,
            `top-level "var" declaration at module scope`,
          )
        }
        if (!pkg.timerAllowlist.has(rel)) {
          for (const decl of stmt.declarationList.declarations) {
            if (!decl.initializer) continue
            const init = decl.initializer
            if (
              ts.isCallExpression(init) &&
              ts.isIdentifier(init.expression) &&
              (init.expression.text === "setInterval" || init.expression.text === "setTimeout")
            ) {
              fail(
                file,
                lineOf(sf, init),
                `${pkg.name}-no-module-timer`,
                `${init.expression.text} at module load — move to Host / runtime lifecycle`,
              )
            }
          }
        }
      }

      if (
        ts.isFunctionDeclaration(stmt) &&
        stmt.name &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const name = stmt.name.text
        if (/^(get|set|reset)Global[A-Z]/.test(name)) {
          fail(
            file,
            lineOf(sf, stmt),
            `${pkg.name}-no-global-getter-setter`,
            `exported "${name}" — thread state via Host / RunContext`,
          )
        }
      }

      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        ts.isIdentifier(stmt.expression.expression)
      ) {
        const fn = stmt.expression.expression.text
        if ((fn === "setInterval" || fn === "setTimeout") && !pkg.timerAllowlist.has(rel)) {
          fail(
            file,
            lineOf(sf, stmt),
            `${pkg.name}-no-module-timer`,
            `${fn} at module load — move to Host / runtime lifecycle`,
          )
        }
      }
    }
  }
}

export function lintNoAsyncLocalStorage(files) {
  for (const file of files) {
    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "AsyncLocalStorage"
      ) {
        fail(
          file,
          lineOf(sf, node),
          "no-async-local-storage",
          `AsyncLocalStorage is forbidden for DI — pass host/context as parameters`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/**
 * Flat control flow via AST: nested named functions that register
 * listeners / setInterval from inside a hot-path outer function.
 */
export function lintFlatControlFlow(files) {
  const SETUP_OUTER = /^(create|make|build|start|boot|wire|install|listen|setup|init)[A-Z_]/
  const HOT_OUTER =
    /^(on|handle|process|run|execute|dispatch)[A-Z]|Pointer|Mouse|Touch|Drag|Down|Up|Move|Request|Message|Chunk|Data|Event/

  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    const sf = parseSourceFile(file)

    /** @param {ts.Node} node @param {{ name: string }[]} stack @param {boolean} inUseEffect */
    function visit(node, stack, inUseEffect) {
      let nextEffect = inUseEffect
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "useEffect" || node.expression.text === "useLayoutEffect")
      ) {
        nextEffect = true
      }

      let name = null
      if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text
      if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        name = node.name.text
      }

      const isFn = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)

      if (isFn && name && stack.length >= 1 && !inUseEffect) {
        const outer = stack[stack.length - 1]
        if (functionRegistersListener(node) && !SETUP_OUTER.test(outer.name)) {
          if (HOT_OUTER.test(outer.name) || HOT_OUTER.test(name)) {
            fail(
              file,
              lineOf(sf, node),
              "flat-control-flow",
              `Nested function "${name}" inside "${outer.name}" registers a listener or repeating timer. ` +
                `Keep control flow flat: peer handlers + explicit state; wire listeners at setup. ` +
                `See .cursor/rules/first-principles.mdc`,
            )
          }
        }
      }

      const nextStack = name && isFn ? [...stack, { name }] : stack
      ts.forEachChild(node, (child) => visit(child, nextStack, nextEffect))
    }

    visit(sf, [], false)
  }
}

/** @param {ts.Node} fnNode */
function functionRegistersListener(fnNode) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (ts.isCallExpression(n)) {
      const expr = n.expression
      if (ts.isPropertyAccessExpression(expr)) {
        const m = expr.name.text
        if (m === "addEventListener" || m === "on" || m === "once") found = true
      }
      if (ts.isIdentifier(expr) && expr.text === "setInterval") found = true
    }
    if (
      n !== fnNode &&
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n))
    ) {
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(fnNode)
  return found
}

export function lintDeepPackageImports(pkgLabel, files) {
  for (const file of files) {
    const sf = parseSourceFile(file)
    for (const { specifier, line } of collectModuleSpecifiers(sf)) {
      if (/packages\/agent\/src\//.test(specifier) || specifier.startsWith("@mia/agent/src/")) {
        fail(
          file,
          line,
          "no-deep-agent-import",
          `${pkgLabel} must import "@mia/agent", not packages/agent/src/**`,
        )
      }
      if (/packages\/sync\/src\//.test(specifier) || specifier.startsWith("@mia/sync/src/")) {
        fail(
          file,
          line,
          "no-deep-sync-import",
          `${pkgLabel} must import "@mia/sync", not packages/sync/src/**`,
        )
      }
    }
  }
}
