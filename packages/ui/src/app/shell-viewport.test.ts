import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { pinShellTrackScroll } from "./shell-viewport"

const here = dirname(fileURLToPath(import.meta.url))

describe("pinShellTrackScroll", () => {
  it("zeros horizontal and vertical scroll on the dual-mount track", () => {
    const track = {
      scrollLeft: 420,
      scrollTop: 12,
    } as HTMLElement

    pinShellTrackScroll(track)

    expect(track.scrollLeft).toBe(0)
    expect(track.scrollTop).toBe(0)
  })

  it("is a no-op for a null track", () => {
    expect(() => pinShellTrackScroll(null)).not.toThrow()
  })

  it("does not write when already pinned", () => {
    const track = {
      scrollLeft: 0,
      scrollTop: 0,
    } as HTMLElement
    const left = vi.fn()
    const top = vi.fn()
    Object.defineProperty(track, "scrollLeft", {
      get: () => 0,
      set: left,
    })
    Object.defineProperty(track, "scrollTop", {
      get: () => 0,
      set: top,
    })

    pinShellTrackScroll(track)

    expect(left).not.toHaveBeenCalled()
    expect(top).not.toHaveBeenCalled()
  })
})

describe("shell viewport CSS contract", () => {
  const css = readFileSync(resolve(here, "../boot/index.css"), "utf8")

  it("clips the dual-mount track so scrollIntoView cannot set scrollLeft", () => {
    expect(css).toMatch(/\.app-shell-track\s*\{[^}]*overflow:\s*clip/s)
  })

  it("keeps inactive panels out of layout/paint like solo-hidden tiles", () => {
    expect(css).toMatch(
      /\.app-shell-panel--inactive\s*\{[^}]*content-visibility:\s*hidden/s,
    )
    expect(css).toMatch(/\.app-shell-panel--inactive\s*\{[^}]*contain:\s*strict/s)
  })

  it("App marks inactive keep-alive panels inert", () => {
    const app = readFileSync(resolve(here, "App.tsx"), "utf8")
    expect(app).toContain("pinShellTrackScroll")
    expect(app).toContain('inert={shellPanelInactive("workspace") ? true : undefined}')
    expect(app).toContain('inert={shellPanelInactive("chat") ? true : undefined}')
  })
})
