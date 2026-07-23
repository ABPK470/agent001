/**
 * Product rules that remain catalog/UI-platform (not capability ownership —
 * that lives in seams.mjs registry runner).
 */

import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import ts from "typescript"
import { fail } from "../report.mjs"
import { lineOf, parseSourceFile } from "../ts-context.mjs"

export function lintUiPlatformCheckbox(uiPkg, files) {
  const checkboxSource = join(uiPkg.src, "components/Checkbox.tsx")
  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    if (file === checkboxSource) continue
    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (ts.isJsxAttribute(node) && node.name && ts.isIdentifier(node.name) && node.name.text === "type") {
        const init = node.initializer
        if (init && ts.isStringLiteral(init) && init.text === "checkbox") {
          fail(
            file,
            lineOf(sf, node),
            "ui-platform-checkbox",
            `Raw type="checkbox" — use Checkbox / LabeledCheckbox from components/Checkbox.tsx`,
          )
        }
        if (
          init &&
          ts.isJsxExpression(init) &&
          init.expression &&
          ts.isStringLiteral(init.expression) &&
          init.expression.text === "checkbox"
        ) {
          fail(
            file,
            lineOf(sf, node),
            "ui-platform-checkbox",
            `Raw type="checkbox" — use Checkbox / LabeledCheckbox from components/Checkbox.tsx`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/** Catalog coverage — every TraceEntry.kind and EventType has a descriptor. */
export function lintEventCatalogCoverage(root) {
  const catalogPath = join(root, "packages/shared-types/src/event-catalog.ts")
  const typesPath = join(root, "packages/shared-types/src/index.ts")
  const eventEnumPath = join(root, "packages/shared-enums/src/event.ts")
  if (!existsSync(catalogPath) || !existsSync(typesPath) || !existsSync(eventEnumPath)) {
    fail(catalogPath, 0, "event-catalog-coverage", "missing catalog or EventType sources")
    return
  }

  const catalog = readFileSync(catalogPath, "utf8")
  const traceBlock = catalog.split("TRACE_EVENT_CATALOG")[1]?.split("SSE_EVENT_CATALOG")[0] ?? ""
  const sseBlock = catalog.split("SSE_EVENT_CATALOG")[1]?.split("const UNKNOWN")[0] ?? ""
  const traceIds = new Set([...traceBlock.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]))
  const sseIds = new Set([...sseBlock.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]))

  const typesSrc = readFileSync(typesPath, "utf8")
  const teMatch = typesSrc.match(/export type TraceEntry\s*=([\s\S]*?)\nexport type /)
  const teSlice = teMatch ? teMatch[1] : ""
  const traceKinds = new Set([...teSlice.matchAll(/kind:\s*"([^"]+)"/g)].map((m) => m[1]))

  for (const kind of traceKinds) {
    if (!traceIds.has(kind)) {
      fail(
        catalogPath,
        0,
        "event-catalog-coverage",
        `TraceEntry.kind "${kind}" missing from TRACE_EVENT_CATALOG — add a semantic descriptor.`,
      )
    }
  }
  for (const id of traceIds) {
    if (!traceKinds.has(id)) {
      fail(
        catalogPath,
        0,
        "event-catalog-coverage",
        `TRACE_EVENT_CATALOG "${id}" has no TraceEntry.kind — remove or add the union member.`,
      )
    }
  }

  const enumSrc = readFileSync(eventEnumPath, "utf8")
  const etBlock = enumSrc.match(/export const EventType\s*=\s*\{([\s\S]*?)\}\s*as const/)
  const precise = new Set(
    etBlock ? [...etBlock[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]) : [],
  )

  for (const t of precise) {
    if (!sseIds.has(t)) {
      fail(
        catalogPath,
        0,
        "event-catalog-coverage",
        `EventType "${t}" missing from SSE_EVENT_CATALOG — add a semantic descriptor.`,
      )
    }
  }
  for (const id of sseIds) {
    if (!precise.has(id)) {
      fail(
        catalogPath,
        0,
        "event-catalog-coverage",
        `SSE_EVENT_CATALOG "${id}" is not an EventType — remove or add the enum member.`,
      )
    }
  }
}
