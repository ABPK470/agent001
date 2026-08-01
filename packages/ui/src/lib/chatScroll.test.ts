import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CHAT_EXPAND_BODY_ATTR,
  CHAT_EXPAND_ROOT_ATTR,
  CHAT_SCROLL_HOST_ATTR,
  compensatePinBandInset,
  nearestRevealScrollDelta,
  preserveScrollAnchor,
  revealElementInScrollAncestors,
  shouldParkAfterToggle,
} from "./chatScroll"

function mockScrollHost(stackH: string, scrollTop: number) {
  let css = stackH
  let top = scrollTop
  return {
    style: {
      getPropertyValue(name: string) {
        return name === "--trace-pin-stack-h" ? css : ""
      },
      setProperty(name: string, value: string) {
        if (name === "--trace-pin-stack-h") css = value
      },
    },
    get scrollTop() {
      return top
    },
    set scrollTop(v: number) {
      top = v
    },
  } as unknown as HTMLElement
}

type MockEl = {
  parentElement: MockEl | null
  style: { overflowY: string }
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  isConnected: boolean
  attrs: Record<string, string>
  children: MockEl[]
  getBoundingClientRect: () => DOMRect
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
  hasAttribute: (name: string) => boolean
  closest: (sel: string) => MockEl | null
  querySelector: (sel: string) => MockEl | null
  appendChild: (child: MockEl) => void
  remove: () => void
}

function rect(top: number, height: number, width = 200): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    height,
    x: 0,
    y: top,
    toJSON() {},
  } as DOMRect
}

function attrSelector(sel: string): string | null {
  const m = sel.match(/^\[([^\]]+)\]$/)
  return m ? m[1]! : null
}

function makeEl(init: {
  overflowY?: string
  scrollHeight?: number
  clientHeight?: number
  scrollTop?: number
  top?: number
  height?: number
  attrs?: Record<string, string>
} = {}): MockEl {
  const el: MockEl = {
    parentElement: null,
    style: { overflowY: init.overflowY ?? "visible" },
    scrollTop: init.scrollTop ?? 0,
    scrollHeight: init.scrollHeight ?? 0,
    clientHeight: init.clientHeight ?? 0,
    isConnected: true,
    attrs: { ...(init.attrs ?? {}) },
    children: [],
    getBoundingClientRect: () => rect(init.top ?? 0, init.height ?? 0),
    setAttribute(name, value) {
      el.attrs[name] = value
    },
    getAttribute(name) {
      return el.attrs[name] ?? null
    },
    hasAttribute(name) {
      return name in el.attrs
    },
    closest(sel) {
      const parts = sel.split(",").map((p) => p.trim())
      let node: MockEl | null = el
      while (node) {
        for (const part of parts) {
          const attr = attrSelector(part)
          if (attr && node.hasAttribute(attr)) return node
        }
        node = node.parentElement
      }
      return null
    },
    querySelector(sel) {
      const attr = attrSelector(sel)
      const walk = (node: MockEl): MockEl | null => {
        for (const child of node.children) {
          if (attr && child.hasAttribute(attr)) return child
          const hit = walk(child)
          if (hit) return hit
        }
        return null
      }
      return walk(el)
    },
    appendChild(child) {
      child.parentElement = el
      el.children.push(child)
    },
    remove() {
      if (!el.parentElement) return
      el.parentElement.children = el.parentElement.children.filter((c) => c !== el)
      el.parentElement = null
    },
  }
  return el
}

/** Body screen Y tracks host.scrollTop so multi-pass reveal settles. */
function linkBodyToHost(host: MockEl, body: MockEl, docTop: number, height: number) {
  const hostViewTop = 0
  host.getBoundingClientRect = () => rect(hostViewTop, host.clientHeight)
  body.getBoundingClientRect = () =>
    rect(hostViewTop + (docTop - host.scrollTop), height)
}

async function flushExpandLayout() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

describe("shouldParkAfterToggle", () => {
  it("header visible → fold only (no scroll park)", () => {
    expect(shouldParkAfterToggle(0, 0)).toBe(false)
    expect(shouldParkAfterToggle(40, 40)).toBe(false)
    expect(shouldParkAfterToggle(100, 120)).toBe(false)
    expect(shouldParkAfterToggle(41, 40)).toBe(false)
  })

  it("scrolled into body → park after layout", () => {
    expect(shouldParkAfterToggle(42, 40)).toBe(true)
    expect(shouldParkAfterToggle(800, 40)).toBe(true)
  })
})

describe("nearestRevealScrollDelta", () => {
  it("returns 0 when the element already fits with padding", () => {
    expect(nearestRevealScrollDelta(100, 200, 0, 400)).toBe(0)
  })

  it("scrolls down just enough when the bottom hangs below the fold", () => {
    expect(nearestRevealScrollDelta(150, 280, 0, 200, 12)).toBe(92)
  })

  it("scrolls up when the top sits above the viewport", () => {
    expect(nearestRevealScrollDelta(-40, 60, 0, 200, 12)).toBe(-52)
  })

  it("prefers showing the top of a tall body over chasing its bottom", () => {
    expect(nearestRevealScrollDelta(50, 500, 0, 200, 12)).toBe(38)
  })
})

describe("revealElementInScrollAncestors", () => {
  beforeEach(() => {
    vi.stubGlobal("getComputedStyle", (node: MockEl) => ({
      overflowY: node.style.overflowY,
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("increases host scrollTop when the body sits below the fold", () => {
    const host = makeEl({
      overflowY: "auto",
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    })
    host.setAttribute(CHAT_SCROLL_HOST_ATTR, "")
    const body = makeEl({ height: 80 })
    linkBodyToHost(host, body, 250, 80)
    host.appendChild(body)

    revealElementInScrollAncestors(body as unknown as HTMLElement, host as unknown as HTMLElement)
    expect(host.scrollTop).toBe(142)
  })

  it("does not scroll when the body is already fully visible", () => {
    const host = makeEl({
      overflowY: "auto",
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 0,
    })
    host.setAttribute(CHAT_SCROLL_HOST_ATTR, "")
    const body = makeEl({ height: 80 })
    linkBodyToHost(host, body, 40, 80)
    host.appendChild(body)

    revealElementInScrollAncestors(body as unknown as HTMLElement, host as unknown as HTMLElement)
    expect(host.scrollTop).toBe(0)
  })
})

describe("preserveScrollAnchor", () => {
  beforeEach(() => {
    vi.stubGlobal("getComputedStyle", (node: MockEl) => ({
      overflowY: node.style.overflowY,
    }))
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("expand with body below fold → host scrollTop increases", async () => {
    const host = makeEl({
      overflowY: "auto",
      scrollHeight: 2000,
      clientHeight: 300,
      scrollTop: 0,
      top: 0,
      height: 300,
    })
    host.setAttribute(CHAT_SCROLL_HOST_ATTR, "")

    const root = makeEl()
    root.setAttribute(CHAT_EXPAND_ROOT_ATTR, "")
    const button = makeEl({ top: 40, height: 24 })
    root.appendChild(button)
    host.appendChild(root)

    preserveScrollAnchor(button as unknown as HTMLElement, () => {
      const body = makeEl()
      body.setAttribute(CHAT_EXPAND_BODY_ATTR, "")
      linkBodyToHost(host, body, 320, 100)
      root.appendChild(body)
    })

    await flushExpandLayout()
    expect(host.scrollTop).toBeGreaterThan(0)
  })

  it("expand with fully visible body → no scroll", async () => {
    const host = makeEl({
      overflowY: "auto",
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 0,
      top: 0,
      height: 400,
    })
    host.setAttribute(CHAT_SCROLL_HOST_ATTR, "")

    const root = makeEl()
    root.setAttribute(CHAT_EXPAND_ROOT_ATTR, "")
    const button = makeEl({ top: 40, height: 24 })
    root.appendChild(button)
    host.appendChild(root)

    preserveScrollAnchor(button as unknown as HTMLElement, () => {
      const body = makeEl()
      body.setAttribute(CHAT_EXPAND_BODY_ATTR, "")
      linkBodyToHost(host, body, 70, 80)
      root.appendChild(body)
    })

    await flushExpandLayout()
    expect(host.scrollTop).toBe(0)
  })

  it("collapse while scrolled into body → parks on header", async () => {
    const host = makeEl({
      overflowY: "auto",
      scrollHeight: 2000,
      clientHeight: 300,
      scrollTop: 200,
      top: 0,
      height: 300,
    })
    host.setAttribute(CHAT_SCROLL_HOST_ATTR, "")

    const root = makeEl()
    root.setAttribute(CHAT_EXPAND_ROOT_ATTR, "")
    // Header lives at document Y 40 — screen top tracks host.scrollTop.
    const button = makeEl({ height: 24 })
    button.getBoundingClientRect = () => rect(40 - host.scrollTop, 24)
    const body = makeEl({ top: -100, height: 400 })
    body.setAttribute(CHAT_EXPAND_BODY_ATTR, "")
    root.appendChild(button)
    root.appendChild(body)
    host.appendChild(root)

    preserveScrollAnchor(button as unknown as HTMLElement, () => {
      body.remove()
    })

    await flushExpandLayout()
    // park: offsetInScrollHost stays 40 → scrollTop 38
    expect(host.scrollTop).toBe(38)
  })
})

describe("compensatePinBandInset", () => {
  it("shifts scrollTop with pin-band height so content stays put on screen", () => {
    const el = mockScrollHost("34px", 100)

    compensatePinBandInset(el, 68)
    expect(el.style.getPropertyValue("--trace-pin-stack-h")).toBe("68px")
    expect(el.scrollTop).toBe(134)

    compensatePinBandInset(el, 34)
    expect(el.style.getPropertyValue("--trace-pin-stack-h")).toBe("34px")
    expect(el.scrollTop).toBe(100)
  })

  it("is a no-op when stack height is unchanged", () => {
    const el = mockScrollHost("34px", 50)
    compensatePinBandInset(el, 34)
    expect(el.scrollTop).toBe(50)
  })
})
