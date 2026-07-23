/**
 * Architectural elasticity — general runners; package lists from policy.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import {
  BOUNDED_PACKAGES,
  CORE_PACKAGES,
  FRAMEWORK_DENYLIST,
  PLATFORM_NPM,
  PURE_LAYERS,
} from "../registry/policy.mjs"
import { fail } from "../report.mjs"
import { walk } from "../fs-walk.mjs"
import { collectModuleSpecifiers, lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

export function lintFrameworkDenylist(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    const layer = rel.split("/")[0]
    if (!PURE_LAYERS.has(layer)) continue
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue

    const sf = parseSourceFile(file)
    for (const { specifier, line, isTypeOnly } of collectModuleSpecifiers(sf)) {
      if (isTypeOnly) continue
      const base = specifier.startsWith("node:")
        ? specifier
        : specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]
      if (FRAMEWORK_DENYLIST.has(specifier) || FRAMEWORK_DENYLIST.has(base)) {
        fail(
          file,
          line,
          "elasticity-framework",
          `${pkg.name} ${layer}/ must not value-import "${specifier}" — keep pure layers free of transport/UI/DB drivers.`,
        )
      }
    }
  }
}

export function lintPackageExportSurface(root, pkgLabel, files) {
  /** @type {Map<string, Set<string>>} */
  const allowed = new Map()
  for (const { npm, dir } of BOUNDED_PACKAGES) {
    const pkgJson = join(root, dir, "package.json")
    const keys = new Set(["."])
    if (existsSync(pkgJson)) {
      const json = JSON.parse(readFileSync(pkgJson, "utf8"))
      if (json.exports && typeof json.exports === "object") {
        for (const k of Object.keys(json.exports)) keys.add(k)
      }
    }
    allowed.set(npm, keys)
  }

  for (const file of files) {
    const sf = parseSourceFile(file)
    for (const { specifier, line } of collectModuleSpecifiers(sf)) {
      for (const { npm, dir } of BOUNDED_PACKAGES) {
        const deepFs = new RegExp(`${dir.replace(/\//g, "\\/")}\\/src\\/`)
        if (deepFs.test(specifier) || specifier.startsWith(`${npm}/src/`)) {
          fail(file, line, "elasticity-deep-import", `${pkgLabel} must not import ${dir}/src/**`)
        }
      }

      for (const [pkgName, keys] of allowed) {
        if (specifier === pkgName) continue
        if (!specifier.startsWith(`${pkgName}/`)) continue
        const sub = "." + specifier.slice(pkgName.length)
        if (!keys.has(sub)) {
          fail(
            file,
            line,
            "elasticity-exports",
            `${pkgLabel} imports "${specifier}" but ${pkgName} exports does not list "${sub}"`,
          )
        }
      }
    }
  }
}

export function lintResolvedInputBoundary(packages) {
  for (const name of CORE_PACKAGES) {
    const pkg = packages[name]
    if (!pkg || !existsSync(pkg.src)) continue
    for (const file of walk(pkg.src)) {
      const sf = parseSourceFile(file)
      for (const { specifier, line } of collectModuleSpecifiers(sf)) {
        if (specifier.includes("packages/server/") || specifier.startsWith(PLATFORM_NPM)) {
          fail(
            file,
            line,
            "elasticity-resolved-inputs",
            `${pkg.name} must not import platform shell — composition root resolves inputs`,
          )
        }
      }
    }
  }
}

const FOLKLORE_IDENTIFIERS = new Set(["getTenantConfig", "getPublishedSyncEntityIds"])

/** Ban ambient folklore resolution under agent core/ and sync domain/. */
export function lintResolvedInputFolklore(packages) {
  const checks = [
    { pkg: "agent", layer: "core/" },
    { pkg: "sync", layer: "domain/" },
  ]
  for (const { pkg: pkgName, layer } of checks) {
    const pkg = packages[pkgName]
    if (!pkg || !existsSync(pkg.src)) continue
    for (const file of walk(pkg.src)) {
      const rel = relToPkg(pkg.src, file)
      if (!rel.startsWith(layer)) continue
      if (rel.endsWith(".test.ts")) continue
      const sf = parseSourceFile(file)
      const visit = (node) => {
        if (ts.isIdentifier(node) && FOLKLORE_IDENTIFIERS.has(node.text)) {
          fail(
            file,
            lineOf(sf, node),
            "resolved-inputs-folklore",
            `${pkg.name}/${layer} must not call ${node.text}() — pass resolved inputs from the shell`,
          )
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
  }
}

/** api/ must not import runtime/execution internals (type-only from runtime root is OK). */
export function lintServerApiRuntimeBoundary(packages) {
  const pkg = packages.server
  if (!pkg || !existsSync(pkg.src)) return
  for (const file of walk(pkg.src)) {
    const rel = relToPkg(pkg.src, file)
    if (!rel.startsWith("api/")) continue
    if (rel.endsWith(".test.ts")) continue
    const sf = parseSourceFile(file)
    for (const { specifier, line, isTypeOnly } of collectModuleSpecifiers(sf)) {
      if (isTypeOnly) continue
      if (/runtime\/execution\//.test(specifier.replace(/\\/g, "/"))) {
        fail(
          file,
          line,
          "server-api-runtime-boundary",
          `api/ must not import runtime/execution/** — use runtime commands or type-only imports`,
        )
      }
    }
  }
}
