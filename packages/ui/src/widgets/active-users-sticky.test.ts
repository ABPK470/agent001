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

  it("Viewing as chip uses theme tokens (not dark-only amber text)", () => {
    expect(src).toContain("au-btn-viewing-as")
    expect(src).not.toContain("text-amber-200")
    expect(css).toMatch(/\.au-btn-viewing-as\s*\{[^}]*color:\s*var\(--viewing-as\)/s)
    expect(css).toMatch(
      /:root\[data-theme="light"\]\s+\.au-btn-viewing-as\s*\{[^}]*color:\s*var\(--viewing-as\)/s,
    )
  })
})
