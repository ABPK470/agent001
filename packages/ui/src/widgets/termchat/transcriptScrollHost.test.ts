import { describe, expect, it } from "vitest"
import { transcriptHostScrollAllowed } from "./transcriptScrollHost"

describe("transcriptHostScrollAllowed", () => {
  it("allows a connected host in an active shell panel", () => {
    expect(
      transcriptHostScrollAllowed({
        connected: true,
        underAriaHidden: false,
        underInactivePanel: false,
        panelVisibility: "visible",
      }),
    ).toBe(true)
  })

  it("rejects disconnected hosts", () => {
    expect(
      transcriptHostScrollAllowed({
        connected: false,
        underAriaHidden: false,
        underInactivePanel: false,
        panelVisibility: "visible",
      }),
    ).toBe(false)
  })

  it("rejects aria-hidden keep-alive panels", () => {
    expect(
      transcriptHostScrollAllowed({
        connected: true,
        underAriaHidden: true,
        underInactivePanel: false,
        panelVisibility: "visible",
      }),
    ).toBe(false)
  })

  it("rejects .app-shell-panel--inactive hosts", () => {
    expect(
      transcriptHostScrollAllowed({
        connected: true,
        underAriaHidden: false,
        underInactivePanel: true,
        panelVisibility: "visible",
      }),
    ).toBe(false)
  })

  it("rejects visibility:hidden shell panels", () => {
    expect(
      transcriptHostScrollAllowed({
        connected: true,
        underAriaHidden: false,
        underInactivePanel: false,
        panelVisibility: "hidden",
      }),
    ).toBe(false)
  })
})
