import { describe, expect, it, vi } from "vitest"
import { createDetailSectionController } from "./detail-section-controller"

function section(id: string, open = true) {
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

function row(id: string) {
  return {
    id,
    headerEl: () => null,
  }
}

describe("createDetailSectionController", () => {
  it("moves across rows without wrapping; folds only foldable actives", () => {
    const ctrl = createDetailSectionController()
    const a = row("timeline-a")
    const b = section("budget", false)
    ctrl.register(a)
    ctrl.register(b)

    expect(ctrl.move(1)).toBe(true)
    expect(ctrl.getActiveId()).toBe("timeline-a")
    expect(ctrl.fold(true)).toBe(false)
    expect(ctrl.move(1)).toBe(true)
    expect(ctrl.getActiveId()).toBe("budget")
    expect(ctrl.move(1)).toBe(false)
    expect(ctrl.fold(true)).toBe(true)
    expect(b.isOpen).toBe(true)
    expect(ctrl.toggle()).toBe(true)
    expect(b.isOpen).toBe(false)
  })

  it("notifies subscribers on activation", () => {
    const ctrl = createDetailSectionController()
    const listener = vi.fn()
    ctrl.subscribe(listener)
    ctrl.register(section("a"))
    expect(listener).toHaveBeenCalled()
    ctrl.move(1)
    expect(ctrl.getActiveId()).toBe("a")
  })

  it("←→ peels section then More/Less one level at a time", () => {
    const ctrl = createDetailSectionController()
    let open = false
    let peekOpen = false
    ctrl.register({
      id: "system-2",
      getOpen: () => open,
      setOpen: (next) => {
        open = next
      },
      hasPeek: () => true,
      getPeekOpen: () => peekOpen,
      setPeekOpen: (next) => {
        peekOpen = next
      },
      headerEl: () => null,
    })

    expect(ctrl.fold(true)).toBe(true)
    expect(open).toBe(true)
    expect(peekOpen).toBe(false)

    expect(ctrl.fold(true)).toBe(true)
    expect(peekOpen).toBe(true)

    expect(ctrl.fold(true)).toBe(true)
    expect(peekOpen).toBe(true)

    expect(ctrl.fold(false)).toBe(true)
    expect(peekOpen).toBe(false)
    expect(open).toBe(true)

    expect(ctrl.fold(false)).toBe(true)
    expect(open).toBe(false)
  })
})
