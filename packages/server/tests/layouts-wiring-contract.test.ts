/**
 * Static contract — the SPA's dashboard restore useEffect MUST re-run
 * whenever any input to the server's dashboardIdFor() function changes.
 *
 * v19 collapse:
 *   Identity now has a SINGLE input — `req.session.upn`. dashboardIdFor()
 *   reads only that, so the SPA dep array only needs `[me?.upn]`. No
 *   isAdmin special case, no sid fallback, no anon bucket.
 *
 *   This test now asserts the COLLAPSE — proving the bug class is gone
 *   structurally. If anyone re-introduces a second input to dashboardIdFor
 *   (sid, isAdmin, env flag, …) without also adding the corresponding
 *   dep on the SPA side, the cycle of "dashboard layout disappears after
 *   re-login" regressions returns and this test catches it.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(here, "..", "..", "..")
const APP_TSX = join(REPO_ROOT, "packages", "ui", "src", "App.tsx")
const LAYOUTS_TS = join(REPO_ROOT, "packages", "server", "src", "routes", "layouts.ts")

describe("layouts wiring (v19) — single-input dashboard key", () => {
  it("dashboardIdFor reads ONLY req.session.upn (no sid, no isAdmin)", () => {
    const src = readFileSync(LAYOUTS_TS, "utf8")
    const fnMatch = src.match(/function dashboardIdFor\([\s\S]*?\n\}/)
    expect(fnMatch, "dashboardIdFor should exist in routes/layouts.ts").not.toBeNull()
    const body = fnMatch![0]

    expect(body, "must read req.session.upn").toMatch(/req\.session\.upn|session\.upn/)
    expect(
      body,
      "must NOT read session.sid (anon fallback was the bug)",
    ).not.toMatch(/session\.sid/)
    expect(
      body,
      "must NOT branch on session.isAdmin (admin special-case was the bug)",
    ).not.toMatch(/session\.isAdmin/)
  })

  it("App.tsx restoreDashboardState useEffect deps are exactly [me?.upn]", () => {
    const src = readFileSync(APP_TSX, "utf8")

    const firstUseEffectIdx = src.indexOf("useEffect(")
    expect(firstUseEffectIdx, "App.tsx must use useEffect").toBeGreaterThan(-1)
    const idx = src.indexOf("restoreDashboardState(", firstUseEffectIdx)
    expect(idx, "restoreDashboardState must be called from a useEffect").toBeGreaterThan(-1)

    const effectStart = src.lastIndexOf("useEffect(", idx)
    expect(effectStart, "restoreDashboardState should be inside a useEffect").toBeGreaterThan(-1)

    // Walk to the matching `)` to extract the full effect.
    let i = effectStart + "useEffect(".length
    let depth = 1
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === "(") depth++
      else if (c === ")") depth--
      else if (c === '"' || c === "'" || c === "`") {
        const q = c
        i++
        while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++ }
      }
      i++
    }
    const effectText = src.slice(effectStart, i)

    const depsMatch = effectText.match(/,\s*\[([^\]]*)\]\s*\)\s*$/)
    expect(depsMatch, "restoreDashboardState useEffect must have a deps array").not.toBeNull()
    const deps = depsMatch![1].trim()

    expect(deps, "deps must include me?.upn").toMatch(/me\?\.upn/)
    expect(
      deps,
      "deps must NOT include me?.sessionId (sessionId no longer exists on Me)",
    ).not.toMatch(/me\?\.sessionId/)
    expect(
      deps,
      "deps must NOT include me?.isAdmin (single-input collapse — see header)",
    ).not.toMatch(/me\?\.isAdmin/)
  })
})
