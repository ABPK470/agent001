/**
 * Expanded-user sticky banner — operator always sees name/UPN while
 * scrolling run history (restored after responsive refactor dropped it).
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
      /\.active-users-widget\s+\.au-detail-header\s*\{[^}]*top:\s*var\(--au-sticky-thead-h\)/s,
    )
    expect(css).toContain("--au-sticky-thead-h")
    expect(css).toMatch(
      /\.active-users-widget--table\s*\{[^}]*--au-sticky-thead-h:/s,
    )
    expect(src).toContain("au-detail-header")
  })

  it("run-history thead sticks under the context banner", () => {
    expect(css).toMatch(
      /\.active-users-widget\s+\.au-run-thead\s*\{[^}]*position:\s*sticky/s,
    )
    expect(css).toMatch(
      /top:\s*calc\(\s*var\(--au-sticky-thead-h\)\s*\+\s*var\(--au-sticky-banner-h\)\s*\)/,
    )
    expect(src).toContain("au-run-thead")
  })

  it("does not layout-contain the detail panel (that kills sticky)", () => {
    expect(css).not.toMatch(
      /\.active-users-widget\s+\.au-detail-panel\s*\{[^}]*contain:\s*layout/s,
    )
  })
})
