import { describe, expect, it, vi } from "vitest"
import { createDetailSectionController } from "./detail-section-controller"

function handle(id: string, open = true) {
  let isOpen = open
  return {
    id,
    getOpen: () => isOpen,
    setOpen: (next: boolean) => {
      isOpen = next
    },
    headerEl: () => null,
    get isOpen() {
      return isOpen
    },
  }
}

describe("createDetailSectionController", () => {
  it("moves, toggles, and folds the active section", () => {
    const ctrl = createDetailSectionController()
    const a = handle("a", true)
    const b = handle("b", false)
    ctrl.register(a)
    ctrl.register(b)

    expect(ctrl.move(1)).toBe(true)
    expect(ctrl.getActiveId()).toBe("a")
    expect(ctrl.move(1)).toBe(true)
    expect(ctrl.getActiveId()).toBe("b")
    expect(ctrl.toggle()).toBe(true)
    expect(b.isOpen).toBe(true)
    expect(ctrl.fold(false)).toBe(true)
    expect(b.isOpen).toBe(false)
  })

  it("notifies subscribers on activation", () => {
    const ctrl = createDetailSectionController()
    const listener = vi.fn()
    ctrl.subscribe(listener)
    ctrl.register(handle("a"))
    expect(listener).toHaveBeenCalled()
    ctrl.move(1)
    expect(ctrl.getActiveId()).toBe("a")
  })
})
