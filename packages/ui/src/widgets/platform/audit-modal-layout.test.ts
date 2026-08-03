/**
 * Audit modal layout contracts — table + inspector, no accordion, overflow.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

describe("audit modal table + inspector contracts", () => {
  it("uses fixed grid table — no accordion expand under rows", () => {
    const src = readFileSync(join(here, "AuditModal.tsx"), "utf8")
    expect(src).toContain("audit-log-table")
    expect(src).toContain("audit-log-table__row")
    expect(src).toContain("AuditInspector")
    expect(src).not.toContain("AdminBrowseDetailPanel")
    expect(src).not.toContain("expanded")
    expect(src).not.toContain("ChevronDown")
    expect(src).not.toContain("ChevronRight")
  })

  it("host clips overflow; table contracts when inspector open", () => {
    const src = readFileSync(join(here, "AuditModal.tsx"), "utf8")
    expect(src).toContain("audit-log-host")
    expect(src).toContain("audit-log-host__table")
    expect(src).toContain("min-w-0")
    expect(src).toContain('data-inspector-open={inspectorOpen ? "true" : "false"}')
    expect(src).toContain("title={when}")
    expect(src).toContain("title={summary}")

    const css = readFileSync(join(here, "../../boot/index.css"), "utf8")
    expect(css).toContain(".audit-log-host")
    expect(css).toContain("overflow: hidden")
    expect(css).toContain(".audit-log-host__table")
    expect(css).toContain("overflow-x: hidden")
    expect(css).toContain(".audit-log-table__cell")
    expect(css).toContain("grid-template-columns: subgrid")
    expect(css).toContain("minmax(7.5rem, max-content)")
    expect(css).toContain("minmax(0, 1fr)")
    expect(css).toContain("column-gap: 1.5rem")
    expect(css).toContain('data-inspector-open="true"] .audit-log-host__table')
    expect(css).toContain("margin-right: var(--audit-inspector-w)")
    expect(css).toContain(".audit-log-table__cell--action")
    expect(css).toContain(".audit-log-table__cell--summary")
    expect(css).not.toContain(".audit-log-table__col--scope {\n  display: none")
  })

  it("inspector uses transform slide-over dialect + CatalogJsonDiff", () => {
    const inspector = readFileSync(join(here, "AuditInspector.tsx"), "utf8")
    expect(inspector).toContain('className="audit-inspector"')
    expect(inspector).toContain('data-open={open ? "true" : "false"}')
    expect(inspector).toContain("onTransitionEnd")
    expect(inspector).toContain("JsonViewer")
    expect(inspector).toContain("CatalogJsonDiff")
    expect(inspector).toContain("auditChangeHints")
    expect(inspector).toContain("Historical version no longer available")
    expect(inspector).toContain("resolveVersionRef")
    expect(inspector).toContain("auditValueStacks")
    expect(inspector).toContain("audit-inspector__resize")
    expect(inspector).toContain("onToggleWide")

    const css = readFileSync(join(here, "../../boot/index.css"), "utf8")
    expect(css).toContain("translate3d(100%, 0, 0)")
    expect(css).toContain(".audit-inspector[data-open=\"true\"]")
    expect(css).toContain("--audit-inspector-w")
    expect(css).toContain(".audit-inspector__prop--stacked")
    expect(css).toContain("word-break: break-word")
    expect(css).toContain("box-shadow: none")
  })

  it("table does not prefetch version refs (drawer-only resolve)", () => {
    const modal = readFileSync(join(here, "AuditModal.tsx"), "utf8")
    expect(modal).not.toContain("getEntityRegistry")
    expect(modal).not.toContain("getEntityRegistryStrategy")
    expect(modal).not.toContain("getSyncCatalogVersionDiff")
    expect(modal).toContain("auditSummary")
  })

  it("filters use FilterSheet + chips dialect", () => {
    const src = readFileSync(join(here, "AuditModal.tsx"), "utf8")
    expect(src).toContain("FilterSheet")
    expect(src).toContain("ActiveFilterChips")
    expect(src).toContain("filterBtnRef")
    expect(src).not.toContain("AdminBrowseFiltersPanel")
  })

  it("table header uses cap fill — toolbar owns the control/data rule", () => {
    const css = readFileSync(join(here, "../../boot/index.css"), "utf8")
    expect(css).toMatch(
      /\.audit-log-table__head\s*\{[^}]*background:\s*var\(--section-cap-bg/s,
    )
    expect(css).not.toMatch(
      /\.audit-log-table__head\s*\{[^}]*border-bottom/s,
    )
    expect(css).toMatch(/\.browse-strip\s*\{[^}]*border-bottom/s)
  })

  it("wires j/k selection stepping + scroll into view", () => {
    const src = readFileSync(join(here, "AuditModal.tsx"), "utf8")
    expect(src).toContain('e.key === "j"')
    expect(src).toContain('e.key === "k"')
    expect(src).toContain("stepSelection")
    expect(src).toContain("scrollSelectedRowIntoView")
    expect(src).toContain("data-audit-id")
    expect(src).toContain('block: "nearest"')
  })
})
