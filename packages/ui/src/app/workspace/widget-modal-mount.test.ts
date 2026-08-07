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
    // Peek is a focused operator surface — same instance + claim path as a tile.
    expect(modal).toContain("WidgetInstanceProvider")
    expect(modal).toContain("peekWidgetInstanceId")
    expect(modal).toContain("toolbar-ops-btn")
    expect(modal).toContain("toolbar-ops-btn--danger")
    expect(modal).not.toContain("widget-shell-icon--danger")
    expect(modal).not.toContain("widget-modal-add-btn")

    // Peek mounts outside .workspace-chrome — chip radius must be on :root.
    const css = readFileSync(join(here, "../../boot/index.css"), "utf8")
    expect(css).toMatch(
      /:root,\s*:root\[data-theme="dark"\],\s*:root\[data-theme="light"\]\s*\{[^}]*--view-chip-radius:\s*0\.375rem/s,
    )
  })
})
