import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fail } from "../report.mjs"
import { walk } from "../fs-walk.mjs"

/** @param {import('./config.mjs').createPackageConfigs extends Function ? any : never} pkg */
export function lintForbiddenTrees(pkg) {
  for (const tree of pkg.forbiddenTrees) {
    const abs = join(pkg.src, tree)
    if (existsSync(abs)) {
      fail(
        abs,
        0,
        `${pkg.name}-forbidden-tree`,
        `doctrine forbids packages/${pkg.name}/src/${tree}/ — see docs/doctrine.md`,
      )
    }
  }

  if (pkg.name === "server" && pkg.forbidApiNestDirs) {
    const apiRoot = join(pkg.src, "api")
    if (!existsSync(apiRoot)) return
    for (const file of walk(apiRoot)) {
      const parts = relative(pkg.src, file).split("/")
      for (const nest of pkg.forbidApiNestDirs) {
        if (parts.includes(nest)) {
          fail(
            file,
            0,
            "server-forbidden-tree",
            `doctrine forbids api/**/${nest}/ — use service/ | types/ | state/ | handlers/`,
          )
          return
        }
      }
      if (parts.includes("hosting")) {
        fail(file, 0, "server-forbidden-tree", `doctrine forbids hosting/ — use api/runs/prompting/`)
        return
      }
      if (parts.includes("deploy")) {
        fail(
          file,
          0,
          "server-forbidden-tree",
          `doctrine forbids api/**/deploy/ — use api/platform/; keep "deploy" in filenames only`,
        )
        return
      }
      // api/agents and other erased surfaces: enforced by seams registry (seam-erased)
    }
  }
}

export function lintTopLevel(pkg) {
  if (!existsSync(pkg.src)) return
  const allowedHeads = new Set([...pkg.layers, ...pkg.allowedExtraDirs])
  for (const name of readdirSync(pkg.src)) {
    if (name.startsWith(".")) continue
    const abs = join(pkg.src, name)
    const st = statSync(abs)
    if (st.isFile()) {
      if (pkg.allowedRootFiles.has(name)) continue
      if (name.endsWith(".md") || name.endsWith(".css")) continue
      fail(abs, 0, `${pkg.name}-top-level`, `unexpected file at ${pkg.name} src root: ${name}`)
      continue
    }
    if (!allowedHeads.has(name)) {
      fail(
        abs,
        0,
        `${pkg.name}-top-level`,
        `unknown ${pkg.name} top-level "${name}". Allowed: ${[...allowedHeads].join(", ")}`,
      )
    }
  }
}
