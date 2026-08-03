/**
 * Expanded-user sticky stack — user row pins, then runs toolbar + run thead.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

describe("Active Users sticky context banner", () => {
  const css = readFileSync(join(here, "../boot/index.css"), "utf8")
  const src = readFileSync(join(here, "ActiveUsers.tsx"), "utf8")

  it("detail colspan cell spans full table width", () => {
    expect(src).toContain("au-detail-cell")
    expect(css).toMatch(/\.active-users-widget\s+\.au-detail-cell\s*\{[^}]*min-width:\s*100%/s)
    expect(css).not.toMatch(/\.active-users-widget\s+\.au-detail-row\s*\{[^}]*display:\s*block/s)
  })

  it("open user row sticks under the users thead", () => {
    expect(src).toContain("au-user-row--open")
    expect(css).toMatch(
      /\.active-users-widget--table\s+\.au-users-table\s+tbody\s+tr\.au-user-row--open\s*>\s*td\s*\{[^}]*position:\s*sticky/s,
    )
    expect(css).toMatch(
      /top:\s*calc\(\s*var\(--au-sticky-thead-h\)\s*-\s*1px\s*\)/,
    )
    expect(css).toContain("--au-sticky-user-row-h")
  })

  it("runs toolbar sticks under the open user row", () => {
    expect(css).toMatch(
      /\.active-users-widget\s+\.au-run-toolbar\s*\{[^}]*position:\s*sticky/s,
    )
    expect(css).toMatch(
      /var\(--au-sticky-thead-h\)\s*\+\s*var\(--au-sticky-user-row-h\)/,
    )
    expect(src).toContain("au-run-toolbar")
    expect(src).not.toContain("au-detail-collapse")
  })

  it("run-history thead sticks under the runs toolbar", () => {
    expect(css).toMatch(
      /\.active-users-widget\s+\.au-run-thead\s*\{[^}]*position:\s*sticky/s,
    )
    expect(css).toMatch(
      /var\(--au-sticky-thead-h\)\s*\+\s*var\(--au-sticky-user-row-h\)\s*\+\s*var\(--au-sticky-runs-bar-h\)/,
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

  it("run details use inline accordion under selected row — no slide-over drawer", () => {
    expect(src).toContain("ActiveUsersRunAccordionPanel")
    expect(src).toContain("au-run-accordion-row")
    expect(src).not.toContain("ActiveUsersRunInspector")
    expect(src).not.toContain("au-run-host")
  })

  it("user agent renders compact badges in metadata grid", () => {
    expect(src).toContain("UserAgentSummary")
    expect(src).toContain("au-detail-ua__badge")
  })

  it("main table header uses distinct band from body rows", () => {
    expect(css).toContain("--au-table-head-bg")
    expect(css).toContain("--au-table-body-bg")
    expect(css).toMatch(
      /\.active-users-widget--table\s+\.au-users-table\s*>\s*thead\s+th\s*\{[^}]*background-color:\s*var\(--au-table-head-bg\)/s,
    )
    expect(css).toMatch(
      /\.active-users-widget--table\s+\.au-users-table\s+tbody\s+td\s*\{[^}]*background-color:\s*var\(--au-table-body-bg\)/s,
    )
  })

  it("run-history thead uses the same header band token", () => {
    expect(css).toMatch(
      /\.active-users-widget\s+\.au-run-thead\s+th\s*\{[^}]*background-color:\s*var\(--au-table-head-bg\)/s,
    )
  })
})
