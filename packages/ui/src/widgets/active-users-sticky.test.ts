/**
 * Expanded-user sticky stack — operator always sees name/UPN and the Runs
 * toolbar while scrolling run history (restored after responsive refactor).
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

describe("Active Users sticky context banner", () => {
  const css = readFileSync(join(here, "../boot/index.css"), "utf8")
  const src = readFileSync(join(here, "ActiveUsers.tsx"), "utf8")

  it("detail header sticks under the users thead (or scrollport top in stack)", () => {
    expect(css).toMatch(
      /\.active-users-widget\s+\.au-detail-header\s*\{[^}]*position:\s*sticky/s,
    )
    expect(css).toMatch(
      /\.active-users-widget\s+\.au-detail-header\s*\{[^}]*top:\s*calc\(\s*var\(--au-sticky-thead-h\)\s*-\s*1px\s*\)/s,
    )
    expect(css).toContain("--au-sticky-thead-h")
    expect(css).toMatch(
      /\.active-users-widget--table\s*\{[^}]*--au-sticky-thead-h:/s,
    )
    expect(src).toContain("au-detail-header")
  })

  it("runs toolbar sticks under the context banner", () => {
    expect(css).toMatch(
      /\.active-users-widget\s+\.au-run-toolbar\s*\{[^}]*position:\s*sticky/s,
    )
    expect(css).toContain("--au-sticky-runs-bar-h")
    expect(css).toMatch(
      /top:\s*calc\(\s*var\(--au-sticky-thead-h\)\s*\+\s*var\(--au-sticky-banner-h\)\s*-\s*1px\s*\)/,
    )
    expect(src).toContain("au-run-toolbar")
  })

  it("run-history thead sticks under the runs toolbar", () => {
    expect(css).toMatch(
      /\.active-users-widget\s+\.au-run-thead\s*\{[^}]*position:\s*sticky/s,
    )
    expect(css).toMatch(
      /var\(--au-sticky-thead-h\)\s*\+\s*var\(--au-sticky-banner-h\)\s*\+\s*var\(--au-sticky-runs-bar-h\)/,
    )
    expect(src).toContain("au-run-thead")
  })

  it("does not layout-contain the detail panel (that kills sticky)", () => {
    expect(css).not.toMatch(
      /\.active-users-widget\s+\.au-detail-panel\s*\{[^}]*contain:\s*layout/s,
    )
  })

  it("frames expanded detail in a nest so following users are not read as runs", () => {
    expect(src).toContain("au-detail-nest")
    expect(css).toMatch(/\.active-users-widget\s+\.au-detail-nest\s*\{/s)
    expect(css).not.toMatch(
      /\.active-users-widget\s+\.au-detail-nest\s*\{[^}]*overflow:\s*hidden/s,
    )
  })

  it("users count beside icon uses compact toolbar count (no min-width gap)", () => {
    expect(src).toMatch(/WidgetToolbarCount[\s\S]*compact/)
    expect(css).toContain("browse-count--compact")
  })

  it("run details use inline accordion under selected row — no slide-over drawer", () => {
    expect(src).toContain("ActiveUsersRunAccordionPanel")
    expect(src).toContain("au-run-accordion-row")
    expect(src).toContain("detailRef")
    expect(src).not.toContain("ActiveUsersRunInspector")
    expect(src).not.toContain("au-run-host")
    expect(src).not.toContain("data-inspector-open")
    expect(css).toMatch(/\.active-users-widget\s+\.au-run-accordion\s*\{/s)
    expect(css).not.toContain("--au-run-inspector-w")
    expect(css).not.toContain("grid-template-columns: minmax(0, 1fr) var(--au-run-inspector-w)")
  })

  it("users table columns reserve min width — headers don't crush when detail expands", () => {
    expect(css).toContain(".au-col-when")
    expect(css).toContain("min-width: 7.25rem")
    expect(css).toContain("min-width: 68rem")
    expect(src).toContain('className="au-col-when"')
  })

  it("user agent renders compact badges, not raw break-all block", () => {
    expect(src).toContain("UserAgentSummary")
    expect(src).toContain("summarizeUserAgent")
    expect(src).toContain("au-detail-ua__badge")
    expect(css).toContain(".au-detail-ua__badge")
  })

  it("Viewing as chip uses theme tokens (not dark-only amber text)", () => {
    expect(src).toContain("au-btn-viewing-as")
    expect(src).not.toContain("text-amber-200")
    expect(css).toMatch(/\.au-btn-viewing-as\s*\{[^}]*color:\s*var\(--viewing-as\)/s)
    expect(css).toMatch(
      /:root\[data-theme="light"\]\s+\.au-btn-viewing-as\s*\{[^}]*color:\s*var\(--viewing-as\)/s,
    )
  })
})
