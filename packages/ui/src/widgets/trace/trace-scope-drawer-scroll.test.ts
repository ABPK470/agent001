import { describe, expect, it } from "vitest"
import { scrollScopeDrawerRowIntoList } from "./trace-scope-drawer-scroll"

describe("scrollScopeDrawerRowIntoList", () => {
  it("scrolls up when the row sits above the list viewport", () => {
    const list = {
      getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
      scrollTop: 80,
    } as HTMLElement
    const row = {
      getBoundingClientRect: () => ({ top: 60, bottom: 90 }),
    } as HTMLElement

    scrollScopeDrawerRowIntoList(list, row)
    expect(list.scrollTop).toBe(40)
  })

  it("scrolls down when the row sits below the list viewport", () => {
    const list = {
      getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
      scrollTop: 0,
    } as HTMLElement
    const row = {
      getBoundingClientRect: () => ({ top: 420, bottom: 450 }),
    } as HTMLElement

    scrollScopeDrawerRowIntoList(list, row)
    expect(list.scrollTop).toBe(50)
  })

  it("does nothing when the row is already visible", () => {
    const list = {
      getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
      scrollTop: 20,
    } as HTMLElement
    const row = {
      getBoundingClientRect: () => ({ top: 150, bottom: 180 }),
    } as HTMLElement

    scrollScopeDrawerRowIntoList(list, row)
    expect(list.scrollTop).toBe(20)
  })
})
