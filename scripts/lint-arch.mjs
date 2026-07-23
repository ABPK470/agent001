/**
 * lint-arch — asymmetric leverage engine for docs/doctrine.md.
 *
 * Enforces Internal Leverage (elasticity, deterministic evolution, sub-linear ops)
 * via TypeScript AST + seams registry — not one-off historical bans.
 *
 * Run: `npm run lint:arch`  (node scripts/lint-arch.mjs)
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createLeverageDebt, createPackageConfigs } from "./lint-arch/config.mjs"
import { walk } from "./lint-arch/fs-walk.mjs"
import { printReport } from "./lint-arch/report.mjs"
import { loadCompilerOptions } from "./lint-arch/ts-context.mjs"
import {
  lintFlatControlFlow,
  lintModuleState,
  lintNoAsyncLocalStorage,
} from "./lint-arch/rules/code-shape.mjs"
import {
  lintFrameworkDenylist,
  lintPackageExportSurface,
  lintResolvedInputBoundary,
} from "./lint-arch/rules/elasticity.mjs"
import {
  lintImportCycles,
  lintLayerImports,
  lintStaleAllowlists,
  lintStaleCycleAllowlist,
} from "./lint-arch/rules/layers.mjs"
import { lintStaleDebtList, lintTenantIdentityForks } from "./lint-arch/rules/ops.mjs"
import { lintEventCatalogCoverage, lintUiPlatformCheckbox } from "./lint-arch/rules/product.mjs"
import {
  lintDialectHomes,
  lintErasedSeams,
  lintRegisteredApiSurfaces,
  lintWireKindDialect,
} from "./lint-arch/rules/seams.mjs"
import { lintForbiddenTrees, lintTopLevel } from "./lint-arch/rules/trees.mjs"

const ROOT = resolve(fileURLToPath(import.meta.url), "../..")
const PACKAGES = createPackageConfigs(ROOT)
const DEBT = createLeverageDebt(ROOT)

function lintPackage(pkg) {
  if (!existsSync(pkg.src)) return { fileCount: 0 }
  lintForbiddenTrees(pkg)
  lintTopLevel(pkg)

  const { options, host } = loadCompilerOptions(pkg.tsconfig)
  const files = walk(pkg.src)

  const graph = lintLayerImports(pkg, files, options, host)
  const pkgCycles = DEBT.cycleAllowlist.filter((a) => a.pkg === pkg.name)
  lintImportCycles(pkg, graph, pkgCycles)
  lintStaleAllowlists(pkg)

  lintModuleState(pkg, files)
  if (pkg.name === "agent") {
    lintNoAsyncLocalStorage(files)
  }

  lintFlatControlFlow(files)
  lintFrameworkDenylist(pkg, files)
  lintPackageExportSurface(ROOT, pkg.name, files)

  if (pkg.name === "server") {
    lintTenantIdentityForks(pkg, files, DEBT.tenantBranchAllowlist)
  }

  if (pkg.name === "ui") {
    lintUiPlatformCheckbox(pkg, files)
    lintWireKindDialect(ROOT, pkg, files)
  }

  return { fileCount: files.length }
}

const counts = {}
for (const key of ["agent", "server", "sync", "ui"]) {
  counts[key] = lintPackage(PACKAGES[key]).fileCount
}

lintStaleCycleAllowlist(DEBT.cycleAllowlist, "leverage")

lintRegisteredApiSurfaces(ROOT, DEBT.brandAllowlist)
lintErasedSeams(ROOT, PACKAGES)
lintDialectHomes(ROOT, DEBT.presentationAllowlist)
lintResolvedInputBoundary(PACKAGES.agent, PACKAGES.sync)
lintEventCatalogCoverage(ROOT)

lintStaleDebtList(DEBT.brandAllowlist, "stale-brand-allowlist", "brand surface")
lintStaleDebtList(DEBT.presentationAllowlist, "stale-presentation-allowlist", "presentation")
lintStaleDebtList(DEBT.tenantBranchAllowlist, "stale-tenant-branch-allowlist", "tenant-branch")

const debtCount =
  PACKAGES.agent.layerAllowlist.length +
  PACKAGES.server.layerAllowlist.length +
  PACKAGES.sync.layerAllowlist.length +
  PACKAGES.ui.layerAllowlist.length +
  DEBT.cycleAllowlist.length +
  DEBT.brandAllowlist.length +
  DEBT.presentationAllowlist.length +
  DEBT.tenantBranchAllowlist.length

if (printReport(ROOT)) {
  process.exit(1)
}

console.log(
  `lint-arch: ${counts.agent} agent + ${counts.server} server + ${counts.sync} sync + ${counts.ui} ui files OK ` +
    `(AST + seams; ${debtCount} debt allowlist entries).`,
)
process.exit(0)
