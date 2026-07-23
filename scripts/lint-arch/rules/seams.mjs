/**
 * Seams + dialect runners — general deterministic-evolution enforcement.
 * Erased fingerprints and active surfaces come from seams.mjs (data).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { BRAND_PATH_PATTERN, DIALECT_CLASSES, SEAMS } from "../seams.mjs"
import { fail } from "../report.mjs"
import { isTestFile, walk } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

function isMigrationPath(file) {
  return /\/migrations\//.test(file.replace(/\\/g, "/"))
}

/** Every api/<name>/ must map to an active seam; erased surfaces must not exist. */
export function lintRegisteredApiSurfaces(root, brandAllowlist) {
  const apiRoot = join(root, "packages/server/src/api")
  if (!existsSync(apiRoot)) return

  const activeBySurface = new Map()
  const owners = new Map()
  for (const s of SEAMS) {
    if (s.status === "active" && s.apiSurface) {
      activeBySurface.set(s.apiSurface, s)
    }
    if (s.status === "active") {
      if (owners.has(s.owner)) {
        fail(
          join(root, s.owner),
          0,
          "seam-owner-unique",
          `Two active seams share owner "${s.owner}": "${owners.get(s.owner)}" and "${s.id}". One owner per capability.`,
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
      fail(
        abs,
        0,
        "seam-erased",
        `API surface "${name}" belongs to erased seam "${erased.id}". Do not resurrect. ${erased.notes ?? ""}`.trim(),
      )
      continue
    }

    const seam = activeBySurface.get(name)
    if (!seam) {
      fail(
        abs,
        0,
        "seam-unregistered",
        `Unknown api/${name}/ — register an active seam in scripts/lint-arch/seams.mjs (additive evolution). See docs/doctrine.md`,
      )
      continue
    }

    if (BRAND_PATH_PATTERN.test(`/${name}/`)) {
      const allowed = brandAllowlist.find((a) => a.surface === name)
      if (allowed) {
        allowed.used = true
      } else {
        fail(
          abs,
          0,
          "ops-branded-surface",
          `api/${name}/ looks customer-branded. Use a domain noun (warehouse, connector, …) or add shrinking brandAllowlist debt. Variance belongs in tenant/deploy data.`,
        )
      }
    }
  }
}

/** Erased seams: forbidPaths must not exist; forbidIdentifiers must not appear. */
export function lintErasedSeams(root, packages) {
  for (const seam of SEAMS) {
    if (seam.status !== "erased") continue

    for (const p of seam.forbidPaths ?? []) {
      const abs = join(root, p)
      if (existsSync(abs)) {
        fail(
          abs,
          0,
          "seam-erased",
          `Erased seam "${seam.id}" path must not exist: ${p}. ${seam.notes ?? ""}`.trim(),
        )
      }
    }

    /** @type {Map<string, Map<string, typeof seam>>} */
    const byPkg = new Map()
    for (const entry of seam.forbidIdentifiers ?? []) {
      for (const pkgName of entry.packages ?? ["agent", "ui", "server", "sync"]) {
        if (!byPkg.has(pkgName)) byPkg.set(pkgName, new Map())
        byPkg.get(pkgName).set(entry.id, seam)
      }
    }

    for (const [pkgName, idMap] of byPkg) {
      const pkg = packages[pkgName]
      if (!pkg || !existsSync(pkg.src)) continue
      for (const file of walk(pkg.src)) {
        const rel = relToPkg(pkg.src, file)
        if (isTestFile(rel)) continue
        if (isMigrationPath(file)) continue
        const sf = parseSourceFile(file)
        const visit = (node) => {
          if (ts.isIdentifier(node) && idMap.has(node.text)) {
            const s = idMap.get(node.text)
            fail(
              file,
              lineOf(sf, node),
              "seam-erased",
              `Identifier "${node.text}" belongs to erased seam "${s.id}". ${s.notes ?? "Do not resurrect."}`.trim(),
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
 * Dialect uniqueness for presentation-labels and spawn-kernel.
 */
export function lintDialectHomes(root, presentationAllowlist) {
  const uiSrc = join(root, "packages/ui/src")
  const labelOwners = DIALECT_CLASSES.find((d) => d.id === "presentation-labels")?.owners ?? []
  if (existsSync(uiSrc)) {
    for (const file of walk(uiSrc)) {
      const rel = relative(root, file).split("\\").join("/")
      if (isTestFile(rel)) continue
      const sf = parseSourceFile(file)
      for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue
          const name = decl.name.text
          // Wire/tool presentation SoT only — not local UI chrome labels (TAB_LABELS, etc.)
          if (!/^(TOOL_.*LABELS?|TOOL_PAST_TENSE|TRACE_KIND_LABELS)$/.test(name)) continue
          if (labelOwners.some((o) => rel.startsWith(o))) continue
          const debt = presentationAllowlist.find((a) => a.file === rel)
          if (debt) {
            debt.used = true
            continue
          }
          fail(
            file,
            lineOf(sf, decl),
            "dialect-presentation-labels",
            `"${name}" is a presentation-labels dialect map (tool/wire vocabulary) — must live under ${labelOwners.join(", ")}. ` +
              `Move to @mia/shared-types or add shrinking presentationAllowlist debt. See docs/doctrine.md`,
          )
        }
      }
    }
  }

  const agentSrc = join(root, "packages/agent/src")
  const spawnOwners = DIALECT_CLASSES.find((d) => d.id === "spawn-kernel")?.owners ?? []
  if (existsSync(agentSrc)) {
    for (const file of walk(agentSrc)) {
      const rel = relative(root, file).split("\\").join("/")
      if (isTestFile(rel)) continue
      if (spawnOwners.some((o) => rel.startsWith(o))) continue
      // Thin planner adapter next to kernel is part of the same dialect home parent
      if (rel.includes("/tools/delegate-spawn/") || rel.includes("/tools/delegate/")) continue
      const sf = parseSourceFile(file)
      for (const stmt of sf.statements) {
        const exported =
          stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
          (ts.isVariableStatement(stmt) &&
            stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        if (ts.isFunctionDeclaration(stmt) && stmt.name && exported) {
          checkSpawnName(file, sf, stmt, stmt.name.text, spawnOwners)
        }
        if (ts.isVariableStatement(stmt) && exported) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              checkSpawnName(file, sf, decl, decl.name.text, spawnOwners)
            }
          }
        }
      }
    }
  }
}

function checkSpawnName(file, sf, node, name, spawnOwners) {
  if (/^(createDelegate|createDelegation)/.test(name)) {
    fail(
      file,
      lineOf(sf, node),
      "dialect-spawn-kernel",
      `Exported "${name}" is spawn-kernel dialect — only under ${spawnOwners.join(", ")}. ` +
        `One spawn kernel; planner owns fan-out. See docs/doctrine.md`,
    )
  }
}

/**
 * Wire-events dialect: widgets/state must not switch on catalogued TraceEntry.kind.
 * Kinds derived from catalog (general).
 */
export function lintWireKindDialect(root, uiPkg, files) {
  const catalogPath = join(root, "packages/shared-types/src/event-catalog.ts")
  if (!existsSync(catalogPath)) return
  const catalog = readFileSync(catalogPath, "utf8")
  const traceBlock = catalog.split("TRACE_EVENT_CATALOG")[1]?.split("SSE_EVENT_CATALOG")[0] ?? ""
  const wireKinds = new Set([...traceBlock.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]))

  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    const rel = relToPkg(uiPkg.src, file)
    if (isTestFile(rel)) continue
    if (rel.startsWith("lib/events/")) continue
    if (rel.startsWith("components/outline/")) continue
    if (!rel.startsWith("widgets/") && !rel.startsWith("state/")) continue

    const sf = parseSourceFile(file)
    if (/\bTRACE_KIND_LABELS\b/.test(sf.getFullText())) {
      fail(
        file,
        0,
        "dialect-wire-events",
        `TRACE_KIND_LABELS is wire-events dialect — use eventLabel / describeDebugTracePayload from @mia/shared-types`,
      )
    }

    const visit = (node) => {
      if (ts.isCaseClause(node) && node.expression && ts.isStringLiteral(node.expression)) {
        if (wireKinds.has(node.expression.text)) {
          fail(
            file,
            lineOf(sf, node),
            "dialect-wire-events",
            `Widget/state must not switch on wire TraceEntry.kind "${node.expression.text}". ` +
              `Use event-catalog + lib/events projection (wire-events dialect). See docs/doctrine.md`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}
