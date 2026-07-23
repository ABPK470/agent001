/**
 * Owned-identity enforcement — general shotgun-surgery detector.
 * Any *Id spanning ≥ IDENTITY_SPAN_MIN packages must be in OWNED_IDENTITIES.
 */

import ts from "typescript"
import {
  IDENTITY_NOISE,
  IDENTITY_SPAN_MIN,
  OWNED_IDENTITIES,
} from "../registry/identities.mjs"
import { fail } from "../report.mjs"
import { isTestFile, walk } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

const ID_RE = /^[a-z][a-zA-Z0-9]*Id$/

/**
 * @param {Record<string, { name: string, src: string }>} packages
 * @param {{ name: string, note: string, used?: boolean }[]} debtAllowlist
 */
export function lintOwnedIdentities(packages, debtAllowlist = []) {
  /** @type {Map<string, { packages: Set<string>, samples: { pkg: string, file: string, line: number }[] }>} */
  const found = new Map()

  for (const pkg of Object.values(packages)) {
    if (!pkg?.src) continue
    for (const file of walk(pkg.src)) {
      const rel = relToPkg(pkg.src, file)
      if (isTestFile(rel)) continue
      if (!/\.(tsx?|jsx?)$/.test(file)) continue
      const sf = parseSourceFile(file)
      collectIdentityProps(sf, (name, node) => {
        if (IDENTITY_NOISE.has(name) || !ID_RE.test(name)) return
        if (!found.has(name)) found.set(name, { packages: new Set(), samples: [] })
        const entry = found.get(name)
        entry.packages.add(pkg.name)
        if (entry.samples.length < 4) {
          entry.samples.push({
            pkg: pkg.name,
            file,
            line: lineOf(sf, node),
          })
        }
      })
    }
  }

  const ownedByName = new Map(OWNED_IDENTITIES.map((o) => [o.name, o]))

  for (const [name, info] of found) {
    if (info.packages.size < IDENTITY_SPAN_MIN) continue

    const owned = ownedByName.get(name)
    if (owned) {
      owned.used = true
      continue
    }

    const debt = debtAllowlist.find((a) => a.name === name)
    if (debt) {
      debt.used = true
      continue
    }

    const pkgs = [...info.packages].sort().join(", ")
    const sample = info.samples[0]
    fail(
      sample.file,
      sample.line,
      "unowned-identity",
      `"${name}" is painted across packages [${pkgs}] without an owned-identity registry row. ` +
        `That is the shotgun-surgery failure class (private identity, no single owner). ` +
        `Register it in scripts/lint-arch/registry/identities.mjs under the owning seam, ` +
        `or stop threading it through the stack. See docs/doctrine.md.`,
    )
  }

  for (const o of OWNED_IDENTITIES) {
    if (o.used) continue
    fail(
      "lint-arch/registry/identities.mjs",
      0,
      "stale-owned-identity",
      `Owned identity "${o.name}" (seam ${o.ownerSeam}) never observed spanning packages — remove or fix. Allowlists/registries must stay honest.`,
    )
  }
}

/** @param {ts.SourceFile} sf @param {(name: string, node: ts.Node) => void} onProp */
function collectIdentityProps(sf, onProp) {
  const visit = (node) => {
    if (ts.isPropertySignature(node) && node.name && ts.isIdentifier(node.name)) {
      onProp(node.name.text, node.name)
    }
    if (ts.isPropertyDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      onProp(node.name.text, node.name)
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      onProp(node.name.text, node.name)
    }
    if (ts.isBindingElement(node) && node.name && ts.isIdentifier(node.name)) {
      onProp(node.name.text, node.name)
    }
    if (ts.isParameter(node) && node.name && ts.isIdentifier(node.name)) {
      onProp(node.name.text, node.name)
    }
    // Interface/type shorthand in object types already covered by PropertySignature
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
