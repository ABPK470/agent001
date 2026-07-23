/**
 * Architectural elasticity — core/domain isolated from transport/storage/UI;
 * package public surfaces only.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { FRAMEWORK_DENYLIST } from "../seams.mjs"
import { fail } from "../report.mjs"
import { walk } from "../fs-walk.mjs"
import { collectModuleSpecifiers, parseSourceFile, relToPkg } from "../ts-context.mjs"

const PURE_LAYERS = new Set(["core", "domain"])

/** Ban framework/transport/DB driver value imports from core|domain. */
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
          `${pkg.name} ${layer}/ must not value-import "${specifier}" — keep domain/core free of HTTP, React, and DB drivers. Use ports + adapters.`,
        )
      }
    }
  }
}

/**
 * Enforce package import surface: only keys listed in package.json exports
 * (plus bare package name). Filesystem deep paths always forbidden.
 */
export function lintPackageExportSurface(root, pkgLabel, files) {
  const specs = [
    { name: "@mia/agent", pkgJson: join(root, "packages/agent/package.json") },
    { name: "@mia/sync", pkgJson: join(root, "packages/sync/package.json") },
    { name: "@mia/server", pkgJson: join(root, "packages/server/package.json") },
  ]

  /** @type {Map<string, Set<string>>} */
  const allowed = new Map()
  for (const { name, pkgJson } of specs) {
    if (!existsSync(pkgJson)) {
      allowed.set(name, new Set(["."]))
      continue
    }
    const json = JSON.parse(readFileSync(pkgJson, "utf8"))
    const exportsMap = json.exports
    const keys = new Set(["."])
    if (exportsMap && typeof exportsMap === "object" && !Array.isArray(exportsMap)) {
      for (const k of Object.keys(exportsMap)) keys.add(k)
    }
    allowed.set(name, keys)
  }

  for (const file of files) {
    const sf = parseSourceFile(file)
    for (const { specifier, line } of collectModuleSpecifiers(sf)) {
      if (/packages\/agent\/src\//.test(specifier) || specifier.startsWith("@mia/agent/src/")) {
        fail(file, line, "elasticity-deep-import", `${pkgLabel} must not import packages/agent/src/**`)
        continue
      }
      if (/packages\/sync\/src\//.test(specifier) || specifier.startsWith("@mia/sync/src/")) {
        fail(file, line, "elasticity-deep-import", `${pkgLabel} must not import packages/sync/src/**`)
        continue
      }
      if (/packages\/server\/src\//.test(specifier) || specifier.startsWith("@mia/server/src/")) {
        fail(file, line, "elasticity-deep-import", `${pkgLabel} must not import packages/server/src/**`)
        continue
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
            `${pkgLabel} imports "${specifier}" but ${pkgName} package.json exports does not list "${sub}". ` +
              `Import "${pkgName}" or an exported subpath only.`,
          )
        }
      }
    }
  }
}

/** Cores must not import server (resolved inputs at composition root). */
export function lintResolvedInputBoundary(agentPkg, syncPkg) {
  for (const pkg of [agentPkg, syncPkg]) {
    if (!pkg || !existsSync(pkg.src)) continue
    for (const file of walk(pkg.src)) {
      const sf = parseSourceFile(file)
      for (const { specifier, line } of collectModuleSpecifiers(sf)) {
        if (specifier.includes("packages/server/") || specifier.startsWith("@mia/server")) {
          fail(
            file,
            line,
            "elasticity-resolved-inputs",
            `${pkg.name} must not import server — composition root resolves inputs; cores stay free of platform folklore.`,
          )
        }
      }
    }
  }
}
