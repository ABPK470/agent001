/**
 * Boundary / port / brand / error-registry hardness.
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { OWNED_IDENTITIES } from "../registry/identities.mjs"
import {
  ERROR_CODE_REGISTRY_FILES,
  FRAMEWORK_DENYLIST,
  JSON_BOUNDARY_PREFIXES,
  JSON_PARSE_HELPER_FILES,
  PORT_LEAK_PATH_RE,
} from "../registry/policy.mjs"
import { fail } from "../report.mjs"
import { isTestFile } from "../fs-walk.mjs"
import {
  collectModuleSpecifiers,
  lineOf,
  parseSourceFile,
  relToPkg,
} from "../ts-context.mjs"

const ERROR_CODE_LIT = /^[A-Z][A-Z0-9_]{2,}$/

/**
 * Class 21 — JSON.parse at trust boundaries must go through named helpers.
 */
export function lintSchemaAtBoundary(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const repoRel = `${pkg.name}/${rel}`
    if (JSON_PARSE_HELPER_FILES.includes(repoRel)) continue
    if (!JSON_BOUNDARY_PREFIXES.some((p) => rel.startsWith(p))) continue

    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (isJsonParseCall(node)) {
        fail(
          file,
          lineOf(sf, node),
          "schema-at-boundary",
          `Raw JSON.parse at the boundary. Use a named decoder (returns unknown), then validate — never JSON.parse(...) as T. See docs/doctrine.md.`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/** @param {ts.Node} node */
function isJsonParseCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON" &&
    node.expression.name.text === "parse"
  )
}

/**
 * Class 22 — owned *Id must not be bare string in domain/core.
 */
export function lintBrandedTypes(pkg, files) {
  if (pkg.name !== "agent" && pkg.name !== "sync") return
  const owned = new Set(OWNED_IDENTITIES.map((i) => i.name))

  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    const layer = rel.split("/")[0]
    if (layer !== "domain" && layer !== "core") continue
    if (rel.includes("branded-ids") || /\/ids\.ts$/.test(rel)) continue

    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
        checkIdString(file, sf, node.name, node.type, owned)
      }
      if (ts.isParameter(node)) {
        checkIdString(file, sf, node.name, node.type, owned)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

function checkIdString(file, sf, nameNode, typeNode, owned) {
  if (!typeNode || !nameNode) return
  const name = ts.isIdentifier(nameNode) ? nameNode.text : null
  if (!name || !owned.has(name)) return
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
    fail(
      file,
      lineOf(sf, typeNode),
      "branded-types",
      `"${name}: string" in domain/core — opaque primitive. Use a branded id type. See docs/doctrine.md.`,
    )
  }
}

/**
 * Class 23 — ports must not import frameworks or infra/adapters paths.
 */
export function lintLeakFreePorts(pkg, files) {
  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (!rel.startsWith("ports/")) continue
    if (isTestFile(rel)) continue

    const sf = parseSourceFile(file)
    for (const { specifier, line } of collectModuleSpecifiers(sf)) {
      const bare = specifier.startsWith("node:")
        ? specifier
        : specifier.replace(/^node:/, "").split("/")[0]
      if (FRAMEWORK_DENYLIST.has(specifier) || FRAMEWORK_DENYLIST.has(bare)) {
        fail(
          file,
          line,
          "leak-free-ports",
          `ports/ imports framework "${specifier}" — leaky abstraction. Ports name contracts only.`,
        )
      }
      if (PORT_LEAK_PATH_RE.test(specifier) || /(?:^|[./])infra(?:\/|$)/.test(specifier)) {
        fail(
          file,
          line,
          "leak-free-ports",
          `ports/ imports infra/adapter path "${specifier}" — leaky abstraction.`,
        )
      }
    }
  }
}

/**
 * Class 17 — UPPER_SNAKE `code:` string literals must be registry imports.
 */
export function lintErrorRegistry(root, pkg, files) {
  const registryCodeSet = loadRegistryCodes(root)

  for (const file of files) {
    const rel = relToPkg(pkg.src, file)
    if (isTestFile(rel)) continue
    if (isErrorRegistryFile(file)) continue
    if (rel.startsWith("cli/")) continue

    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === "code") ||
          (ts.isStringLiteral(node.name) && node.name.text === "code")) &&
        ts.isStringLiteral(node.initializer) &&
        ERROR_CODE_LIT.test(node.initializer.text)
      ) {
        const code = node.initializer.text
        fail(
          file,
          lineOf(sf, node),
          "error-registry",
          registryCodeSet.has(code)
            ? `Error code "${code}" must be imported from the registry — no string literal. See docs/doctrine.md.`
            : `Error code "${code}" is not registered. Add it to a registry module, then import. See docs/doctrine.md.`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

function isErrorRegistryFile(file) {
  const norm = file.replace(/\\/g, "/")
  return ERROR_CODE_REGISTRY_FILES.some((r) => norm.endsWith(r.replace(/\\/g, "/")))
}

function loadRegistryCodes(root) {
  const codes = new Set()
  for (const rel of ERROR_CODE_REGISTRY_FILES) {
    const abs = join(root, rel)
    if (!existsSync(abs)) continue
    const text = readFileSync(abs, "utf8")
    for (const m of text.matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)) {
      codes.add(m[1])
    }
  }
  return codes
}
