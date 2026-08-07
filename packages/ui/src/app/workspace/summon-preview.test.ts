import { describe, expect, it } from "vitest"
import { buildSpaceView, PRODUCT_SPACES } from "../../lib/spaces"
import { resolveSummonPreview, summonPreviewHotkeyHint } from "./summon-preview"
import type { SummonItem } from "./summon-items"

function productViews() {
  return PRODUCT_SPACES.map((def) => buildSpaceView(def))
}

const reconcile: SummonItem = {
  kind: "space",
  id: "space:reconcile",
  name: "Reconcile",
  desc: "Sync",
  index: 3,
}

const observeReset: SummonItem = {
  kind: "bundle",
  id: "bundle:observe-core",
  name: "Observe · reset",
  desc: "Restore Pipelines",
  homeSpace: "space:observe",
  focusType: "operation-log",
}

const chat: SummonItem = {
  kind: "widget",
  type: "term-chat",
  name: "MI:A Chat",
  desc: "Talk",
  group: "agent",
}

describe("resolveSummonPreview", () => {
  it("Reconcile Space → 2-tile blueprint", () => {
    const model = resolveSummonPreview(reconcile, productViews(), {
      presentTypes: new Set(),
    })
    expect(model.mode).toBe("blueprint")
    if (model.mode !== "blueprint") return
    expect(model.pickable).toHaveLength(2)
    expect(model.name).toBe("Reconcile")
  })

  it("Trace Space → 1-tile blueprint", () => {
    const model = resolveSummonPreview(
      {
        kind: "space",
        id: "space:trace",
        name: "Trace",
        desc: "Inspect",
        index: 5,
      },
      productViews(),
      { presentTypes: new Set() },
    )
    expect(model.mode).toBe("blueprint")
    if (model.mode !== "blueprint") return
    expect(model.pickable).toHaveLength(1)
  })

  it("preset previews home Space blueprint", () => {
    const model = resolveSummonPreview(observeReset, productViews(), {
      presentTypes: new Set(),
    })
    expect(model.mode).toBe("blueprint")
    if (model.mode !== "blueprint") return
    expect(model.name).toBe("Observe")
    expect(model.pickable.length).toBeGreaterThanOrEqual(2)
  })

  it("widget → surface card with · here when present", () => {
    const absent = resolveSummonPreview(chat, productViews(), {
      presentTypes: new Set(),
    })
    expect(absent).toMatchObject({
      mode: "surface",
      onActiveSpace: false,
      name: "MI:A Chat",
    })
    const present = resolveSummonPreview(chat, productViews(), {
      presentTypes: new Set(["term-chat"]),
    })
    expect(present).toMatchObject({ mode: "surface", onActiveSpace: true })
  })

  it("idle when nothing selected", () => {
    expect(
      resolveSummonPreview(null, productViews(), {
        presentTypes: new Set(),
      }).mode,
    ).toBe("idle")
  })

  it("hotkey hint scales with tile count", () => {
    expect(summonPreviewHotkeyHint(1)).toBe("1")
    expect(summonPreviewHotkeyHint(3)).toBe("1–3")
  })
})
