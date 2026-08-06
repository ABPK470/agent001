/**
 * Peek must mount outside the shell slider — transform traps position:fixed.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

describe("WidgetModal mount", () => {
  it("App mounts peek at root beside Summon, not inside workspace-chrome", () => {
    const app = readFileSync(join(here, "../App.tsx"), "utf8")
    const modal = readFileSync(join(here, "WidgetModal.tsx"), "utf8")

    expect(app).toContain("<SummonPalette />")
    expect(app).toContain("<KeymapSheet />")
    expect(app).toContain("<WidgetModal />")
    expect(app).toContain("Outside the shell track")

    // workspace-chrome path must not nest a second peek under the transform.
    const chromeStart = app.indexOf('className={[\n        "workspace-chrome')
    const chromeEnd = app.indexOf("function shellPanelInactive")
    expect(chromeStart).toBeGreaterThan(-1)
    expect(chromeEnd).toBeGreaterThan(chromeStart)
    expect(app.slice(chromeStart, chromeEnd)).not.toContain("<WidgetModal />")

    expect(modal).toContain("app-shell-slider")
    expect(modal).toContain("Must mount at the app root")
  })
})
