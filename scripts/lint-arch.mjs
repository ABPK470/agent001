/**
 * lint-arch — doctrine enforcement engine.
 *
 * Uniform dispatch: package rules from config, global rules after.
 * Product-specific names live ONLY in registry/ + debt data — never in runners.
 *
 * Run: `npm run lint:arch`
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  createLeverageDebt,
  createPackageConfigs,
  GLOBAL_RULES,
  PACKAGE_EXTRA_RULES,
  PACKAGE_RULES,
} from "./lint-arch/config.mjs"
import { walk } from "./lint-arch/fs-walk.mjs"
import { printReport } from "./lint-arch/report.mjs"
import { loadCompilerOptions } from "./lint-arch/ts-context.mjs"
import { FORBIDDEN_CONSTRUCTORS } from "./lint-arch/registry/policy.mjs"
import {
  lintFlatControlFlow,
  lintModuleState,
  lintNoForbiddenConstructors,
} from "./lint-arch/rules/code-shape.mjs"
import {
  lintFrameworkDenylist,
  lintPackageExportSurface,
  lintResolvedInputBoundary,
} from "./lint-arch/rules/elasticity.mjs"
import {
  lintDomainSurface,
  lintSilentFailure,
  lintTrustHygiene,
} from "./lint-arch/rules/external.mjs"
import {
  lintImportCycles,
  lintLayerImports,
  lintStaleAllowlists,
  lintStaleCycleAllowlist,
} from "./lint-arch/rules/layers.mjs"
import { lintStaleDebtList, lintTenantIdentityForks } from "./lint-arch/rules/ops.mjs"
import { lintCatalogCoverage, lintJsxAttrBans } from "./lint-arch/rules/catalog.mjs"
import {
  lintDialects,
  lintErasedSeams,
  lintRegisteredApiSurfaces,
} from "./lint-arch/rules/seams.mjs"
import { lintForbiddenTrees, lintTopLevel } from "./lint-arch/rules/trees.mjs"

const ROOT = resolve(fileURLToPath(import.meta.url), "../..")
const PACKAGES = createPackageConfigs(ROOT)
const DEBT = createLeverageDebt(ROOT)

/** @type {Map<string, (ctx: object) => void>} */
const RUNNERS = new Map([
  ["forbidden-trees", ({ pkg }) => lintForbiddenTrees(pkg)],
  ["top-level", ({ pkg }) => lintTopLevel(pkg)],
  [
    "layers",
    ({ pkg, files, options, host }) => {
      const graph = lintLayerImports(pkg, files, options, host)
      pkg._importGraph = graph
    },
  ],
  [
    "cycles",
    ({ pkg }) => {
      const pkgCycles = DEBT.cycleAllowlist.filter((a) => a.pkg === pkg.name)
      lintImportCycles(pkg, pkg._importGraph ?? new Map(), pkgCycles)
      lintStaleAllowlists(pkg)
    },
  ],
  ["module-state", ({ pkg, files }) => lintModuleState(pkg, files)],
  ["flat-control-flow", ({ files }) => lintFlatControlFlow(files)],
  ["framework-deny", ({ pkg, files }) => lintFrameworkDenylist(pkg, files)],
  ["export-surface", ({ pkg, files }) => lintPackageExportSurface(ROOT, pkg.name, files)],
  ["silent-failure", ({ pkg, files }) => lintSilentFailure(pkg, files, DEBT.silentFailureAllowlist)],
  ["trust", ({ pkg, files }) => lintTrustHygiene(pkg, files, DEBT.trustAllowlist)],
  [
    "forbidden-constructors",
    ({ pkg, files }) => lintNoForbiddenConstructors(pkg, files, FORBIDDEN_CONSTRUCTORS),
  ],
  [
    "identity-forks",
    ({ pkg, files }) => lintTenantIdentityForks(pkg, files, DEBT.tenantBranchAllowlist),
  ],
  ["jsx-attr-ban", ({ pkg, files }) => lintJsxAttrBans(pkg, files)],
  [
    "domain-surface",
    ({ pkg, files }) =>
      lintDomainSurface(ROOT, pkg, files, DEBT.enumForkAllowlist, DEBT.jargonAllowlist),
  ],
  [
    "seams",
    () => {
      lintRegisteredApiSurfaces(ROOT, DEBT.brandAllowlist, DEBT.brandTokens)
      lintErasedSeams(ROOT, PACKAGES)
    },
  ],
  [
    "dialects",
    () =>
      lintDialects(ROOT, {
        presentationAllowlist: DEBT.presentationAllowlist,
      }),
  ],
  ["catalog-coverage", () => lintCatalogCoverage(ROOT)],
  ["resolved-inputs", () => lintResolvedInputBoundary(PACKAGES)],
  [
    "stale-debt",
    () => {
      lintStaleCycleAllowlist(DEBT.cycleAllowlist, "leverage")
      lintStaleDebtList(DEBT.brandAllowlist, "stale-debt", "brand")
      lintStaleDebtList(DEBT.presentationAllowlist, "stale-debt", "presentation")
      lintStaleDebtList(DEBT.tenantBranchAllowlist, "stale-debt", "identity-fork")
      lintStaleDebtList(DEBT.silentFailureAllowlist, "stale-debt", "silent-failure")
      lintStaleDebtList(DEBT.trustAllowlist, "stale-debt", "trust")
      lintStaleDebtList(DEBT.enumForkAllowlist, "stale-debt", "enum-fork")
      lintStaleDebtList(DEBT.jargonAllowlist, "stale-debt", "jargon")
    },
  ],
])

function runRule(name, ctx) {
  const fn = RUNNERS.get(name)
  if (!fn) throw new Error(`lint-arch: unknown rule "${name}"`)
  fn(ctx)
}

const counts = {}
for (const pkg of Object.values(PACKAGES)) {
  if (!existsSync(pkg.src)) {
    counts[pkg.name] = 0
    continue
  }
  const { options, host } = loadCompilerOptions(pkg.tsconfig)
  const files = walk(pkg.src)
  const rules = [...PACKAGE_RULES, ...(PACKAGE_EXTRA_RULES[pkg.name] ?? [])]
  const ctx = { pkg, files, options, host }
  for (const rule of rules) runRule(rule, ctx)
  counts[pkg.name] = files.length
}

for (const rule of GLOBAL_RULES) runRule(rule, {})

const debtCount =
  PACKAGES.agent.layerAllowlist.length +
  PACKAGES.server.layerAllowlist.length +
  PACKAGES.sync.layerAllowlist.length +
  PACKAGES.ui.layerAllowlist.length +
  DEBT.cycleAllowlist.length +
  DEBT.brandAllowlist.length +
  DEBT.presentationAllowlist.length +
  DEBT.tenantBranchAllowlist.length +
  DEBT.silentFailureAllowlist.length +
  DEBT.trustAllowlist.length +
  DEBT.enumForkAllowlist.length +
  DEBT.jargonAllowlist.length

if (printReport(ROOT)) process.exit(1)

console.log(
  `lint-arch: ${counts.agent} agent + ${counts.server} server + ${counts.sync} sync + ${counts.ui} ui files OK ` +
    `(general runners + registry data; ${debtCount} debt entries).`,
)
process.exit(0)
