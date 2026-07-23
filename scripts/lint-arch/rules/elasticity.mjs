/**
 * Architectural elasticity — general runners; package lists from policy.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BOUNDED_PACKAGES,
  CORE_PACKAGES,
  FRAMEWORK_DENYLIST,
  PLATFORM_NPM,
  PURE_LAYERS,
} from "../registry/policy.mjs"
import { fail } from "../report.mjs"
import { walk } from "../fs-walk.mjs"
import { collectModuleSpecifiers, parseSourceFile, relToPkg } from "../ts-context.mjs"

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
