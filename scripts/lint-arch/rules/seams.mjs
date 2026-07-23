/**
 * Seams + dialects — GENERAL runners. Product names live only in registry data.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { DIALECT_CLASSES } from "../registry/dialects.mjs"
import { brandPathPattern, SEAM_API_ROOT } from "../registry/policy.mjs"
import { SEAMS } from "../registry/seams.mjs"
import { fail } from "../report.mjs"
import { isTestFile, walk } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

function isMigrationPath(file) {
  return /\/migrations\//.test(file.replace(/\\/g, "/"))
}

/** Every registered surface root child must map to an active seam. */
export function lintRegisteredApiSurfaces(root, brandAllowlist, brandTokens) {
  const apiRoot = join(root, SEAM_API_ROOT)
  if (!existsSync(apiRoot)) return
  const brandRe = brandPathPattern(brandTokens)

  const activeBySurface = new Map()
  const owners = new Map()
  for (const s of SEAMS) {
    if (s.status === "active" && s.apiSurface) activeBySurface.set(s.apiSurface, s)
    if (s.status === "active") {
      if (owners.has(s.owner)) {
        fail(
          join(root, s.owner),
          0,
          "seam-owner-unique",
          `Two active seams share owner "${s.owner}": "${owners.get(s.owner)}" and "${s.id}"`,
        )
      }
      owners.set(s.owner, s.id)
    }
  }

  for (const name of readdirSync(apiRoot)) {
    if (name === "index.ts" || name.startsWith(".")) continue
    const abs = join(apiRoot, name)
    if (!statSync(abs).isDirectory()) continue

    const erased = SEAMS.find((s) => s.status === "erased" && s.apiSurface === name)
    if (erased) {
      fail(abs, 0, "seam-erased", `Surface "${name}" is erased seam "${erased.id}". ${erased.notes ?? ""}`.trim())
      continue
    }

    if (!activeBySurface.has(name)) {
      fail(
        abs,
        0,
        "seam-unregistered",
        `Unknown api surface "${name}" — register an active seam (additive). See docs/doctrine.md`,
      )
      continue
    }

    if (brandRe.test(`/${name}/`)) {
      const allowed = brandAllowlist.find((a) => a.surface === name)
      if (allowed) allowed.used = true
      else {
        fail(
          abs,
          0,
          "branded-path",
          `Surface "${name}" matches brand token — use a domain noun, or shrinking brandAllowlist debt.`,
        )
      }
    }
  }
}

export function lintErasedSeams(root, packages) {
  for (const seam of SEAMS) {
    if (seam.status !== "erased") continue

    for (const p of seam.forbidPaths ?? []) {
      const abs = join(root, p)
      if (existsSync(abs)) {
        fail(abs, 0, "seam-erased", `Erased seam "${seam.id}" path must not exist: ${p}`)
      }
    }

    /** @type {Map<string, Map<string, typeof seam>>} */
    const byPkg = new Map()
    for (const entry of seam.forbidIdentifiers ?? []) {
      for (const pkgName of entry.packages ?? Object.keys(packages)) {
        if (!byPkg.has(pkgName)) byPkg.set(pkgName, new Map())
        byPkg.get(pkgName).set(entry.id, seam)
      }
    }

    for (const [pkgName, idMap] of byPkg) {
      const pkg = packages[pkgName]
      if (!pkg || !existsSync(pkg.src)) continue
      for (const file of walk(pkg.src)) {
        if (isTestFile(relToPkg(pkg.src, file)) || isMigrationPath(file)) continue
        const sf = parseSourceFile(file)
        const visit = (node) => {
          if (ts.isIdentifier(node) && idMap.has(node.text)) {
            const s = idMap.get(node.text)
            fail(
              file,
              lineOf(sf, node),
              "seam-erased",
              `Identifier "${node.text}" belongs to erased seam "${s.id}". ${s.notes ?? ""}`.trim(),
            )
          }
          ts.forEachChild(node, visit)
        }
        visit(sf)
      }
    }
  }
}

/**
 * One generic dialect engine — criteria from DIALECT_CLASSES.detect.
 * @param {Record<string, unknown[]>} debtByKey e.g. { presentationAllowlist: [...] }
 */
export function lintDialects(root, debtByKey = {}) {
  for (const dialect of DIALECT_CLASSES) {
    const detect = dialect.detect
    if (!detect) continue

    if (detect.kind === "export-name") {
      lintDialectExportName(root, dialect, detect, debtByKey[detect.debtKey] ?? [])
    } else if (detect.kind === "switch-catalog") {
      lintDialectSwitchCatalog(root, dialect, detect)
    }
  }
}

function lintDialectExportName(root, dialect, detect, debtList) {
  const re = new RegExp(detect.re)
  for (const scanRoot of dialect.scanRoots ?? []) {
    const absRoot = join(root, scanRoot)
    if (!existsSync(absRoot)) continue
    for (const file of walk(absRoot)) {
      const rel = relative(root, file).split("\\").join("/")
      if (isTestFile(rel)) continue
      if (dialect.owners.some((o) => rel.startsWith(o))) continue
      if ((dialect.skipPathIncludes ?? []).some((s) => rel.includes(s) || file.includes(s))) continue

      const sf = parseSourceFile(file)
      for (const stmt of sf.statements) {
        const exported =
          stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
          (ts.isVariableStatement(stmt) &&
            stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        if (!exported && !(ts.isVariableStatement(stmt) && !stmt.modifiers)) {
          // also catch non-exported const TOOL_LABELS at module scope (dialect maps)
        }
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name)) continue
            const name = decl.name.text
            if (!re.test(name)) continue
            const debt = debtList.find((a) => a.file === rel)
            if (debt) {
              debt.used = true
              continue
            }
            fail(
              file,
              lineOf(sf, decl),
              "dialect-home",
              `Dialect "${dialect.id}": "${name}" must live under ${dialect.owners.join(", ")}.`,
            )
          }
        }
        if (ts.isFunctionDeclaration(stmt) && stmt.name && exported) {
          const name = stmt.name.text
          if (!re.test(name)) continue
          fail(
            file,
            lineOf(sf, stmt),
            "dialect-home",
            `Dialect "${dialect.id}": exported "${name}" must live under ${dialect.owners.join(", ")}.`,
          )
        }
      }
    }
  }
}

function lintDialectSwitchCatalog(root, dialect, detect) {
  const catalogPath = join(root, detect.catalogFile)
  if (!existsSync(catalogPath)) return
  const catalog = readFileSync(catalogPath, "utf8")
  const block =
    catalog.split(detect.catalogConst)[1]?.split(detect.catalogEndMarker)[0] ?? ""
  const ids = new Set([...block.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]))

  for (const scanRoot of dialect.scanRoots ?? []) {
    const absRoot = join(root, scanRoot)
    if (!existsSync(absRoot)) continue
    const pkgSrc = absRoot
    for (const file of walk(absRoot)) {
      if (!/\.(tsx?|jsx?)$/.test(file)) continue
      const rel = relative(pkgSrc, file).split("\\").join("/")
      if (isTestFile(rel)) continue
      if ((detect.skipPrefixes ?? []).some((p) => rel.startsWith(p))) continue
      if (
        detect.scanPrefixes?.length &&
        !detect.scanPrefixes.some((p) => rel.startsWith(p))
      ) {
        continue
      }

      const sf = parseSourceFile(file)
      const text = sf.getFullText()
      for (const id of detect.forbidIdentifiers ?? []) {
        if (new RegExp(`\\b${id}\\b`).test(text)) {
          fail(
            file,
            0,
            "dialect-home",
            `Dialect "${dialect.id}": identifier "${id}" belongs in ${dialect.owners.join(", ")}.`,
          )
        }
      }

      const visit = (node) => {
        if (ts.isCaseClause(node) && node.expression && ts.isStringLiteral(node.expression)) {
          if (ids.has(node.expression.text)) {
            fail(
              file,
              lineOf(sf, node),
              "dialect-home",
              `Dialect "${dialect.id}": do not switch on wire id "${node.expression.text}" here — use projection owners.`,
            )
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
  }
}
