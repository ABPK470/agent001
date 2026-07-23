import { join } from "node:path"
import { isTestFile } from "../fs-walk.mjs"
import { fail } from "../report.mjs"
import {
  collectModuleSpecifiers,
  parseSourceFile,
  relToPkg,
  resolveModule,
} from "../ts-context.mjs"

function layerOf(pkg, relPath) {
  const head = relPath.split("/")[0]
  return pkg.layers.has(head) ? head : null
}

function matchAllow(pkg, fromRel, toRel) {
  for (const a of pkg.layerAllowlist) {
    if (a.from && a.from !== fromRel) continue
    if (a.fromPrefix && !fromRel.startsWith(a.fromPrefix)) continue
    if (a.toPrefix && !toRel.startsWith(a.toPrefix)) continue
    a.used = true
    return a
  }
  return null
}

/**
 * Build relative import graph + enforce layer matrix.
 * @returns {Map<string, { to: string, line: number }[]>}
 */
export function lintLayerImports(pkg, files, options, host) {
  /** @type {Map<string, { to: string, line: number }[]>} */
  const graph = new Map()

  for (const file of files) {
    const fromRel = relToPkg(pkg.src, file)
    if (pkg.skipTestFilesForLayers && isTestFile(fromRel)) continue
    const fromLayer = layerOf(pkg, fromRel)
    if (!fromLayer) continue

    const sf = parseSourceFile(file)
    for (const { specifier, line, isSideEffect, isTypeOnly } of collectModuleSpecifiers(sf)) {
      if (!specifier.startsWith(".")) continue

      const targetAbs = resolveModule(file, specifier, options, host)
      if (!targetAbs) continue
      const toRel = relToPkg(pkg.src, targetAbs)
      if (toRel.startsWith("..")) continue
      if (toRel === "types.ts" || toRel.startsWith("types.")) continue

      if (!isTypeOnly) {
        if (!graph.has(fromRel)) graph.set(fromRel, [])
        graph.get(fromRel).push({ to: toRel, line })
      }

      const toLayer = layerOf(pkg, toRel)
      if (!toLayer || toLayer === fromLayer) continue

      const allowed = pkg.allowed[fromLayer]
      if (allowed?.has(toLayer)) continue
      if (matchAllow(pkg, fromRel, toRel)) continue

      const side = isSideEffect ? " (side-effect import)" : ""
      fail(
        file,
        line,
        `${pkg.name}-layer-import`,
        `${fromLayer} may not import ${toLayer} ("${specifier}" → ${toRel})${side}. ` +
          `Allowed from ${fromLayer}: ${[...allowed].join(", ") || "(none)"}. See docs/doctrine.md`,
      )
    }
  }

  return graph
}

/**
 * Detect cycles — fail hard unless cycle key is in shrinking cycleAllowlist.
 * @param {{ key: string, note: string, used?: boolean }[]} cycleAllowlist
 */
export function lintImportCycles(pkg, graph, cycleAllowlist = []) {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  /** @type {Map<string, number>} */
  const color = new Map()
  /** @type {string[]} */
  const stack = []
  const reported = new Set()

  function dfs(node) {
    color.set(node, GRAY)
    stack.push(node)
    for (const { to, line } of graph.get(node) ?? []) {
      const c = color.get(to) ?? WHITE
      if (c === GRAY) {
        const idx = stack.indexOf(to)
        const cycle = [...stack.slice(idx), to]
        const key = cycle.slice(0, -1).sort().join("→")
        if (!reported.has(key)) {
          reported.add(key)
          const debt = cycleAllowlist.find((a) => a.key === key)
          if (debt) {
            debt.used = true
          } else {
            fail(
              join(pkg.src, node),
              line,
              `${pkg.name}-import-cycle`,
              `Circular import: ${cycle.join(" → ")}. Break the cycle (extract shared leaf module; never import sibling via barrel). ` +
                `To defer known debt, add key "${key}" to cycleAllowlist (must shrink).`,
            )
          }
        }
      } else if (c === WHITE && graph.has(to)) {
        dfs(to)
      } else if (c === WHITE) {
        color.set(to, BLACK)
      }
    }
    stack.pop()
    color.set(node, BLACK)
  }

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) dfs(node)
  }
}

/** Fail if any debt allowlist entry was never matched. */
export function lintStaleAllowlists(pkg) {
  for (const a of pkg.layerAllowlist) {
    if (a.used) continue
    fail(
      pkg.src,
      0,
      `${pkg.name}-stale-allowlist`,
      `Unused layer debt allowlist entry (${a.from ?? a.fromPrefix ?? "?"} → ${a.toPrefix ?? "?"}): ${a.note}. ` +
        `Remove it — allowlists must shrink.`,
    )
  }
}

export function lintStaleCycleAllowlist(cycleAllowlist, pkgName) {
  for (const a of cycleAllowlist) {
    if (a.used) continue
    fail(
      "lint-arch",
      0,
      `${pkgName}-stale-cycle-allowlist`,
      `Unused cycle allowlist key "${a.key}": ${a.note}. Remove it — allowlists must shrink.`,
    )
  }
}
