/**
 * lint-arch — asymmetric leverage engine for docs/doctrine.md.
 *
 * Deterministic TypeScript AST (not line-regex). One package config schema.
 * Enforces: layers, cycles, side-effect imports, flat control flow,
 * capability ownership, event catalog, forbidden trees, stale debt allowlists.
 *
 * Run: `npm run lint:arch`  (node scripts/lint-arch.mjs)
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createPackageConfigs } from "./lint-arch/config.mjs"
import { walk } from "./lint-arch/fs-walk.mjs"
import { errors, printReport } from "./lint-arch/report.mjs"
import { loadCompilerOptions } from "./lint-arch/ts-context.mjs"
import {
  lintFlatControlFlow,
  lintDeepPackageImports,
  lintModuleState,
  lintNoAsyncLocalStorage,
} from "./lint-arch/rules/code-shape.mjs"
import {
  lintImportCycles,
  lintLayerImports,
  lintStaleAllowlists,
} from "./lint-arch/rules/layers.mjs"
import {
  lintCapabilityOwnership,
  lintEventCatalogCoverage,
  lintUiEventKindSwitch,
  lintUiPlatformCheckbox,
} from "./lint-arch/rules/product.mjs"
import { lintForbiddenTrees, lintTopLevel } from "./lint-arch/rules/trees.mjs"

const ROOT = resolve(fileURLToPath(import.meta.url), "../..")
const PACKAGES = createPackageConfigs(ROOT)

function lintPackage(pkg) {
  if (!existsSync(pkg.src)) return { fileCount: 0 }
  lintForbiddenTrees(pkg)
  lintTopLevel(pkg)

  const { options, host } = loadCompilerOptions(pkg.tsconfig)
  const files = walk(pkg.src)

  const graph = lintLayerImports(pkg, files, options, host)
  const deferredCycles = lintImportCycles(pkg, graph)
  lintStaleAllowlists(pkg)

  if (pkg.name === "agent" || pkg.name === "sync") {
    lintModuleState(pkg, files)
  }
  if (pkg.name === "agent") {
    lintNoAsyncLocalStorage(files)
  }

  lintFlatControlFlow(files)
  lintDeepPackageImports(pkg.name, files)

  if (pkg.name === "ui") {
    lintUiPlatformCheckbox(pkg, files)
    lintUiEventKindSwitch(pkg, files)
  }

  return { fileCount: files.length, deferredCycles }
}

const counts = {}
/** @type {{ file: string, line: number, cycle: string[] }[]} */
const allDeferredCycles = []
for (const key of ["agent", "server", "sync", "ui"]) {
  const r = lintPackage(PACKAGES[key])
  counts[key] = r.fileCount
  if (r.deferredCycles?.length) allDeferredCycles.push(...r.deferredCycles)
}

lintCapabilityOwnership(PACKAGES.agent, PACKAGES.ui)
lintEventCatalogCoverage(ROOT)

const debt =
  PACKAGES.agent.layerAllowlist.length +
  PACKAGES.server.layerAllowlist.length +
  PACKAGES.sync.layerAllowlist.length +
  PACKAGES.ui.layerAllowlist.length

if (printReport(ROOT)) {
  process.exit(1)
}

if (allDeferredCycles.length > 0) {
  console.warn(
    `\nlint-arch: ${allDeferredCycles.length} import-cycle(s) deferred (real debt; not failing). ` +
      `Set LINT_ARCH_STRICT_CYCLES=1 to fail hard.\n`,
  )
  for (const c of allDeferredCycles.slice(0, 20)) {
    const rel = c.file.startsWith(ROOT) ? c.file.slice(ROOT.length + 1) : c.file
    console.warn(`  ${rel}:${c.line}  ${c.cycle.join(" → ")}`)
  }
  if (allDeferredCycles.length > 20) {
    console.warn(`  … and ${allDeferredCycles.length - 20} more`)
  }
  console.warn("")
}

console.log(
  `lint-arch: ${counts.agent} agent + ${counts.server} server + ${counts.sync} sync + ${counts.ui} ui files OK ` +
    `(AST; ${debt} debt allowlist entries` +
    (allDeferredCycles.length
      ? `; ${allDeferredCycles.length} cycle(s) deferred`
      : "") +
    `).`,
)
process.exit(0)
