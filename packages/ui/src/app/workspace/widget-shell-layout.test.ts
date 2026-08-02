import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { catalogEntries, getWidgetDefinition } from "./widget-definitions"
import { wrapWidgetBody } from "./widget-shell-layout"

const here = dirname(fileURLToPath(import.meta.url))

describe("widget shell layout", () => {
  it("maps split layout to registry + sync widgets only", () => {
    const split = catalogEntries()
      .filter((entry) => entry.layout === "split")
      .map((entry) => entry.type)
      .sort()

    expect(split).toEqual([
      "entity-registry",
      "sync-admin",
    ])
    expect(getWidgetDefinition("sync-proposals").layout).toBe("split")
    expect(getWidgetDefinition("term-chat").layout).toBe("canvas")
    expect(getWidgetDefinition("live-logs").layout).toBe("panel")
  })

  it("WidgetShell applies card view to every widget", () => {
    const shell = readFileSync(join(here, "WidgetShell.tsx"), "utf8")
    expect(shell).toContain("workspace-shell--card-view")
    expect(shell).toContain("widget-view-container")
    expect(shell).toContain("wrapWidgetBody")
    expect(shell).not.toContain('flushView ? "workspace-shell--flush-view"')
  })

  it("wrapWidgetBody leaves split interiors bare and panels everything else", () => {
    expect(wrapWidgetBody("split", "raw")).toBe("raw")
    // panel/canvas branches render React elements — smoke via class helper file + CSS.
    const css = readFileSync(join(here, "../../boot/index.css"), "utf8")
    expect(css).toMatch(/\.widget-panel\s*\{[^}]*border:\s*1px solid var\(--border-subtle\)/s)
    expect(css).toMatch(/\.widget-panel\s*\{[^}]*padding:/s)
    expect(css).toMatch(/\.widget-view-container\s*\{[^}]*padding:/s)
    expect(css).toMatch(/\.workspace-tile-solo\s+\.widget-panel\s*\{[^}]*border-radius:/s)
  })
})
