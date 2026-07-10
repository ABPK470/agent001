import { afterEach, describe, expect, it, vi } from "vitest"

import {
  claimPopoverOpen,
  dismissOpenPopovers,
  dismissOtherPopovers,
  registerPopoverInstance,
} from "./popover-dismiss"

describe("popover-dismiss coordinator", () => {
  const unsubs: Array<() => void> = []

  afterEach(() => {
    dismissOpenPopovers()
    for (const unsub of unsubs.splice(0)) unsub()
  })

  it("allows only one popover open at a time", () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    const closeC = vi.fn()

    unsubs.push(registerPopoverInstance("a", closeA))
    unsubs.push(registerPopoverInstance("b", closeB))
    unsubs.push(registerPopoverInstance("c", closeC))

    claimPopoverOpen("a")
    expect(closeA).not.toHaveBeenCalled()
    expect(closeB).not.toHaveBeenCalled()

    claimPopoverOpen("b")
    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).not.toHaveBeenCalled()

    claimPopoverOpen("c")
    expect(closeB).toHaveBeenCalledTimes(1)
    expect(closeC).not.toHaveBeenCalled()
  })

  it("dismisses all registered popovers when modals layer", () => {
    const closeA = vi.fn()
    const closeB = vi.fn()

    unsubs.push(registerPopoverInstance("a", closeA))
    unsubs.push(registerPopoverInstance("b", closeB))
    claimPopoverOpen("a")

    dismissOpenPopovers()
    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).toHaveBeenCalledTimes(1)

    closeA.mockClear()
    closeB.mockClear()

    claimPopoverOpen("b")
    dismissOtherPopovers("b")
    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).not.toHaveBeenCalled()
  })
})
