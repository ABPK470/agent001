/**
 * Catalog coverage + JSX attr bans — driven entirely by registry/policy.mjs.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { CATALOG_SPECS, JSX_ATTR_BANS } from "../registry/policy.mjs"
import { fail } from "../report.mjs"
import { lineOf, parseSourceFile } from "../ts-context.mjs"

export function lintCatalogCoverage(root) {
  for (const spec of CATALOG_SPECS) {
    const catalogPath = join(root, spec.catalogFile)
    const kindsPath = join(root, spec.kindsFile)
    const enumPath = join(root, spec.enumFile)
    if (!existsSync(catalogPath) || !existsSync(kindsPath) || !existsSync(enumPath)) {
      fail(catalogPath, 0, "catalog-coverage", `missing sources for catalog spec ${spec.catalogConst}`)
      continue
    }

    const catalog = readFileSync(catalogPath, "utf8")
    const traceBlock =
      catalog.split(spec.catalogConst)[1]?.split(spec.catalogEndMarker)[0] ?? ""
    const sseBlock = spec.sseConst
      ? catalog.split(spec.sseConst)[1]?.split(spec.enumUnknownMarker ?? "\n\n")[0] ?? ""
      : ""
    const catalogIds = new Set([...traceBlock.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]))
    const sseIds = new Set([...sseBlock.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]))

    const kindsSrc = readFileSync(kindsPath, "utf8")
    const teMatch = kindsSrc.match(
      new RegExp(`export type ${spec.kindsType}\\s*=([\\s\\S]*?)\\nexport type `),
    )
    const kinds = new Set(
      [...(teMatch?.[1] ?? "").matchAll(new RegExp(`${spec.kindsField}:\\s*"([^"]+)"`, "g"))].map(
        (m) => m[1],
      ),
    )

    for (const kind of kinds) {
      if (!catalogIds.has(kind)) {
        fail(
          catalogPath,
          0,
          "catalog-coverage",
          `${spec.kindsType}.${spec.kindsField} "${kind}" missing from ${spec.catalogConst}`,
        )
      }
    }
    for (const id of catalogIds) {
      if (!kinds.has(id)) {
        fail(
          catalogPath,
          0,
          "catalog-coverage",
          `${spec.catalogConst} "${id}" has no ${spec.kindsType}.${spec.kindsField}`,
        )
      }
    }

    const enumSrc = readFileSync(enumPath, "utf8")
    const etBlock = enumSrc.match(
      new RegExp(`export const ${spec.enumConst}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as const`),
    )
    const precise = new Set(
      etBlock ? [...etBlock[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]) : [],
    )

    if (spec.sseConst) {
      for (const t of precise) {
        if (!sseIds.has(t)) {
          fail(
            catalogPath,
            0,
            "catalog-coverage",
            `${spec.enumConst} "${t}" missing from ${spec.sseConst}`,
          )
        }
      }
      for (const id of sseIds) {
        if (!precise.has(id)) {
          fail(
            catalogPath,
            0,
            "catalog-coverage",
            `${spec.sseConst} "${id}" is not a ${spec.enumConst} member`,
          )
        }
      }
    }
  }
}

export function lintJsxAttrBans(pkg, files) {
  const bans = JSX_ATTR_BANS.filter((b) => b.packages.includes(pkg.name))
  if (bans.length === 0) return

  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    const sf = parseSourceFile(file)
    const rel = file.split(/packages\/[^/]+\/src\//)[1]?.split("\\").join("/")

    for (const ban of bans) {
      if (rel === ban.exceptRel) continue
      const visit = (node) => {
        if (
          ts.isJsxAttribute(node) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === ban.attr
        ) {
          const init = node.initializer
          let val = null
          if (init && ts.isStringLiteral(init)) val = init.text
          if (
            init &&
            ts.isJsxExpression(init) &&
            init.expression &&
            ts.isStringLiteral(init.expression)
          ) {
            val = init.expression.text
          }
          if (val === ban.value) {
            fail(
              file,
              lineOf(sf, node),
              "jsx-attr-ban",
              `Raw ${ban.attr}="${ban.value}" — use the shared platform control (except ${ban.exceptRel})`,
            )
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
  }
}
