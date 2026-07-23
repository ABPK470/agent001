import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fail } from "../report.mjs"
import { walk } from "../fs-walk.mjs"

/** Forbidden path prefixes from pkg.forbiddenTrees + optional nest-dir bans. */
export function lintForbiddenTrees(pkg) {
  for (const tree of pkg.forbiddenTrees) {
    const abs = join(pkg.src, tree)
    if (existsSync(abs)) {
      fail(
        abs,
        0,
        "forbidden-tree",
        `Forbidden tree packages/${pkg.name}/src/${tree}/ — see package config + docs/doctrine.md`,
      )
    }
  }

  if (pkg.forbidApiNestDirs?.length) {
    const apiRoot = join(pkg.src, "api")
    if (!existsSync(apiRoot)) return
    for (const file of walk(apiRoot)) {
      const parts = relative(pkg.src, file).split("/")
      for (const nest of pkg.forbidApiNestDirs) {
        if (parts.includes(nest)) {
          fail(
            file,
            0,
            "forbidden-tree",
            `Forbidden nest api/**/${nest}/ — use service/ | types/ | state/ | handlers/`,
          )
          return
        }
      }
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
      fail(abs, 0, "top-level", `unexpected file at ${pkg.name} src root: ${name}`)
      continue
    }
    if (!allowedHeads.has(name)) {
      fail(
        abs,
        0,
        "top-level",
        `unknown ${pkg.name} top-level "${name}". Allowed: ${[...allowedHeads].join(", ")}`,
      )
    }
  }
}
