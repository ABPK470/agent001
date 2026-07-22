/**
 * Trace sticky-scroll + outline regression suite.
 *
 * No Playwright harness in this monorepo — these unit + mock-DOM integration
 * tests lock the pin algorithm, scope depths, chronology, and CSS contracts
 * that made Trace pin UX stable.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  OUTLINE_PIN_FAMILIES,
  OUTLINE_STICKY_MAX,
  OUTLINE_STICKY_ROW_H,
  computePinnedFromEntries,
  computePinnedScopeIds,
  listOutlineScopes,
  samePinnedIds,
  syncPinnedInFlow,
} from "../../lib/events/pin.js"
import { parkScrollOnScope } from "../../lib/chatScroll.js"
import {
  TRACE_PIN_KINDS,
  TRACE_STICKY_MAX,
  TRACE_STICKY_ROW_H,
  expandPathForScope,
  traceScopeDepth,
} from "./trace-pin.js"
import { sqlQualityPhaseLabel } from "./trace-format.js"

const H = TRACE_STICKY_ROW_H

describe("trace sticky constants", () => {
  it("keeps Trace façade aligned with the shared pin engine", () => {
    expect(TRACE_STICKY_ROW_H).toBe(OUTLINE_STICKY_ROW_H)
    expect(TRACE_STICKY_MAX).toBe(OUTLINE_STICKY_MAX)
    expect(TRACE_PIN_KINDS).toBe(OUTLINE_PIN_FAMILIES)
  })

  it("pins message rows (System/User under Sent)", () => {
    expect(OUTLINE_PIN_FAMILIES.has("message")).toBe(true)
    expect(OUTLINE_PIN_FAMILIES.has("sent")).toBe(true)
    expect(OUTLINE_PIN_FAMILIES.has("work")).toBe(true)
  })
})

describe("traceScopeDepth — messages under Sent", () => {
  it("nests message one deeper than Sent/Received", () => {
    expect(traceScopeDepth("sent", false)).toBe(1)
    expect(traceScopeDepth("received", false)).toBe(1)
    expect(traceScopeDepth("message", false)).toBe(2)

    expect(traceScopeDepth("call", true)).toBe(1)
    expect(traceScopeDepth("sent", true)).toBe(2)
    expect(traceScopeDepth("message", true)).toBe(3)
  })

  it("keeps phase/work/call roots coherent", () => {
    expect(traceScopeDepth("phase")).toBe(0)
    expect(traceScopeDepth("work", false)).toBe(0)
    expect(traceScopeDepth("work", true)).toBe(1)
    expect(traceScopeDepth("call", false)).toBe(0)
    expect(traceScopeDepth("prompt")).toBe(1)
  })
})

describe("expandPathForScope — full outline ids", () => {
  it("opens ancestors for every pin-eligible id shape", () => {
    expect(expandPathForScope("context")).toEqual({ preamble: true })
    expect(expandPathForScope("call:3")).toEqual({ callIndex: 3 })
    expect(expandPathForScope("sent:3")).toEqual({ callIndex: 3, sent: true })
    expect(expandPathForScope("received:3")).toEqual({
      callIndex: 3,
      received: true,
    })
    expect(expandPathForScope("message:3:m:2")).toEqual({
      callIndex: 3,
      sent: true,
      messageKey: "3:m:2",
    })
    expect(expandPathForScope("tool:tc-1")).toEqual({
      toolId: "tc-1",
      received: true,
    })
    expect(expandPathForScope("phase-step:frontend")).toEqual({
      phaseId: "phase-step:frontend",
    })
    expect(expandPathForScope("work-0")).toEqual({ workId: "work-0" })
  })
})

describe("sqlQualityPhaseLabel", () => {
  it("shows validated for executed SQL checks (not EXECUTED)", () => {
    expect(sqlQualityPhaseLabel("executed")).toBe("validated")
    expect(sqlQualityPhaseLabel("blocked")).toBe("blocked")
    expect(sqlQualityPhaseLabel("failed")).toBe("failed")
  })
})

describe("computePinnedFromEntries — nested Subagent → Call → Sent → System", () => {
  const nested = [
    { id: "phase-sub", top: 0, depth: 0 },
    { id: "call:0", top: 40, depth: 1 },
    { id: "sent:0", top: 80, depth: 2 },
    { id: "message:0:m:0", top: 120, depth: 3 },
    { id: "message:0:m:1", top: 500, depth: 3 },
    { id: "received:0", top: 900, depth: 2 },
    { id: "work-0", top: 1200, depth: 1 },
  ]

  it("pins Subagent → Call → Sent → System while reading system body", () => {
    expect(computePinnedFromEntries(nested, 300)).toEqual([
      "phase-sub",
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
  })

  it("yields System to User at the same depth (Sent stays)", () => {
    expect(computePinnedFromEntries(nested, 500 + H)).toEqual([
      "phase-sub",
      "call:0",
      "sent:0",
      "message:0:m:1",
    ])
  })

  it("pins Work under Subagent after the call ends", () => {
    expect(computePinnedFromEntries(nested, 1200 + H)).toEqual([
      "phase-sub",
      "work-0",
    ])
  })

  it("never pins Sent and Received together", () => {
    const atRecv = computePinnedFromEntries(nested, 950)
    expect(atRecv).toContain("received:0")
    expect(atRecv).not.toContain("sent:0")
  })
})

describe("peer yield — Context must not cover Plan", () => {
  it("releases Context when Plan reaches the pin slot (overlay)", () => {
    const peers = [
      { id: "context", top: 0, depth: 0 },
      { id: "phase-plan", top: 400, depth: 0 },
    ]
    expect(computePinnedFromEntries(peers, 300)).toEqual(["context"])
    expect(computePinnedFromEntries(peers, 400 - H + 1)).toEqual([])
    expect(computePinnedFromEntries(peers, 400 + H)).toEqual(["phase-plan"])
  })

  it("releases Context when Plan reaches the scrollport top (band)", () => {
    const peers = [
      { id: "context", top: 0, depth: 0 },
      { id: "phase-plan", top: 400, depth: 0 },
    ]
    const band = { stackInScroll: false as const }
    expect(computePinnedFromEntries(peers, 400 - H + 1, H, 4, band)).toEqual([
      "context",
    ])
    expect(computePinnedFromEntries(peers, 400, H, 4, band)).toEqual([])
    expect(computePinnedFromEntries(peers, 400 + H, H, 4, band)).toEqual([
      "phase-plan",
    ])
  })
})

/* ─── mock-DOM integration (same dialect as runNavLayout.test) ─── */

type ScopeSpec = {
  id: string
  kind: string
  depth: number
  top: number
  /** Default true — collapsed headers are not pin-eligible. */
  expanded?: boolean
  leaf?: boolean
}

function mockRect(top: number, height = 34) {
  return {
    top,
    left: 0,
    right: 400,
    bottom: top + height,
    width: 400,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

function makeScopeEl(spec: ScopeSpec, hostTop: number, scrollTop: number) {
  const attrs: Record<string, string> = {
    "data-trace-scope": spec.id,
    "data-trace-kind": spec.kind,
    "data-trace-depth": String(spec.depth),
  }
  if (spec.expanded !== false) {
    attrs["aria-expanded"] = "true"
  } else {
    attrs["aria-expanded"] = "false"
  }
  return {
    dataset: {
      get traceScope() {
        return attrs["data-trace-scope"]
      },
      get outlineScope() {
        return attrs["data-outline-scope"]
      },
      get traceKind() {
        return attrs["data-trace-kind"]
      },
      get outlineFamily() {
        return attrs["data-outline-family"]
      },
      get traceDepth() {
        return attrs["data-trace-depth"]
      },
      get outlineDepth() {
        return attrs["data-outline-depth"]
      },
    },
    classList: {
      contains: (name: string) => name === "is-leaf" && spec.leaf === true,
    },
    hasAttribute: (name: string) => name in attrs,
    getAttribute: (name: string) => attrs[name] ?? null,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value
    },
    removeAttribute: (name: string) => {
      delete attrs[name]
    },
    getBoundingClientRect: () =>
      mockRect(hostTop + spec.top - scrollTop, H),
    offsetHeight: H,
  }
}

function mockTraceHost(scopes: ScopeSpec[], scrollTop: number) {
  const hostTop = 40
  let top = scrollTop
  const els = scopes.map((s) => makeScopeEl(s, hostTop, top))
  const style: { scrollPaddingTop: string } = { scrollPaddingTop: "" }
  const host = {
    get scrollTop() {
      return top
    },
    set scrollTop(v: number) {
      top = v
    },
    style,
    getBoundingClientRect: () => mockRect(hostTop, 600),
    querySelectorAll: (sel: string) => {
      if (sel.includes("data-trace-pinned") || sel.includes("data-outline-pinned")) {
        return els.filter(
          (el) =>
            el.hasAttribute("data-trace-pinned") ||
            el.hasAttribute("data-outline-pinned"),
        )
      }
      if (sel.includes("data-trace-scope") || sel.includes("data-outline-scope")) {
        return els
      }
      return []
    },
    querySelector: (sel: string) => {
      const m =
        /data-trace-scope="([^"]+)"/.exec(sel) ??
        /data-outline-scope="([^"]+)"/.exec(sel)
      if (!m) return null
      return els.find((el) => el.dataset.traceScope === m[1]) ?? null
    },
  }
  return { host: host as unknown as HTMLElement, els, style }
}

describe("listOutlineScopes + computePinnedScopeIds (DOM)", () => {
  it("reads message scopes from data-trace-* and pins them under Sent", () => {
    const scopes: ScopeSpec[] = [
      { id: "call:0", kind: "call", depth: 0, top: 0 },
      { id: "sent:0", kind: "sent", depth: 1, top: 40 },
      { id: "message:0:m:0", kind: "message", depth: 2, top: 80 },
      { id: "message:0:m:1", kind: "message", depth: 2, top: 400 },
    ]
    const { host } = mockTraceHost(scopes, 200)
    const listed = listOutlineScopes(host)
    expect(listed.map((e) => e.id)).toEqual([
      "call:0",
      "sent:0",
      "message:0:m:0",
      "message:0:m:1",
    ])
    expect(listed.find((e) => e.id === "message:0:m:0")?.family).toBe("message")
    expect(computePinnedScopeIds(host)).toEqual([
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
  })

  it("ignores tool leaf rows (not pin families)", () => {
    const scopes: ScopeSpec[] = [
      { id: "call:0", kind: "call", depth: 0, top: 0 },
      { id: "tool:tc1", kind: "tool", depth: 2, top: 100 },
    ]
    const { host } = mockTraceHost(scopes, 200)
    expect(listOutlineScopes(host).map((e) => e.id)).toEqual(["call:0"])
  })

  it("ignores collapsed headers (aria-expanded=false)", () => {
    const scopes: ScopeSpec[] = [
      { id: "call:0", kind: "call", depth: 0, top: 0, expanded: false },
      { id: "call:1", kind: "call", depth: 0, top: 200 },
    ]
    const { host } = mockTraceHost(scopes, 250)
    expect(listOutlineScopes(host).map((e) => e.id)).toEqual(["call:1"])
    expect(computePinnedScopeIds(host, undefined, { stackInScroll: false })).toEqual([
      "call:1",
    ])
  })
})

describe("syncPinnedInFlow — replace contract", () => {
  it("hides in-flow headers that are pinned and sets scroll-padding", () => {
    // Node vitest has no CSS.escape — pin ids are plain and need no escaping.
    const g = globalThis as { CSS?: { escape: (s: string) => string } }
    g.CSS ??= { escape: (s) => s }

    const scopes: ScopeSpec[] = [
      { id: "call:0", kind: "call", depth: 0, top: 0 },
      { id: "sent:0", kind: "sent", depth: 1, top: 40 },
      { id: "message:0:m:0", kind: "message", depth: 2, top: 80 },
    ]
    const { host, els, style } = mockTraceHost(scopes, 200)
    syncPinnedInFlow(host, ["call:0", "sent:0", "message:0:m:0"], H)
    expect(els[0]!.hasAttribute("data-trace-pinned")).toBe(true)
    expect(els[1]!.hasAttribute("data-trace-pinned")).toBe(true)
    expect(els[2]!.hasAttribute("data-trace-pinned")).toBe(true)
    expect(style.scrollPaddingTop).toBe(`${3 * H}px`)

    syncPinnedInFlow(host, ["call:0"], H)
    expect(els[0]!.hasAttribute("data-trace-pinned")).toBe(true)
    expect(els[1]!.hasAttribute("data-trace-pinned")).toBe(false)
    expect(els[2]!.hasAttribute("data-trace-pinned")).toBe(false)
    expect(style.scrollPaddingTop).toBe(`${H}px`)

    syncPinnedInFlow(host, [], H)
    expect(style.scrollPaddingTop).toBe("")
  })

  it("samePinnedIds is order-sensitive", () => {
    expect(samePinnedIds(["a", "b"], ["a", "b"])).toBe(true)
    expect(samePinnedIds(["a", "b"], ["b", "a"])).toBe(false)
  })
})

describe("parkScrollOnScope — collapse while scrolled into body", () => {
  it("parks scroll on the scope header (external pin band: no stack offset)", () => {
    const scopes: ScopeSpec[] = [
      { id: "call:0", kind: "call", depth: 0, top: 0 },
      { id: "tools", kind: "tools", depth: 1, top: 40 },
      { id: "call:1", kind: "call", depth: 0, top: 2000 },
    ]
    const { host, els } = mockTraceHost(scopes, 800)
    const toolsEl = els[1]! as unknown as HTMLElement
    // Trace pins live outside the scrollport — empty stack.
    parkScrollOnScope(host, toolsEl, H, () => [])
    // Must leave the deep scroll that would land on later Call content.
    expect(host.scrollTop).toBeLessThan(200)
  })
})

describe("Trace CSS contract — pin indent + work-note divider", () => {
  const cssPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../boot/index.css",
  )
  const css = readFileSync(cssPath, "utf8")

  it("pin band reserves real height outside the scrollport (not a height-0 overlay)", () => {
    expect(css).toMatch(/\.trace-pin\s*\{[^}]*height:\s*auto/s)
    expect(css).not.toMatch(/\.trace-pin\s*\{[^}]*height:\s*0\b/s)
    expect(css).toContain(".trace-body")
  })

  it("pin stack honors data-trace-depth (messages under Sent)", () => {
    expect(css).toContain('.trace-pin__stack > .trace-scope[data-trace-depth="1"]')
    expect(css).toContain('.trace-pin__stack > .trace-scope[data-trace-depth="2"]')
    expect(css).toContain('.trace-pin__stack > .trace-scope[data-trace-depth="3"]')
  })

  it("pin message indent matches in-flow nest geometry (not ScopeRow depth steps)", () => {
    expect(css).toMatch(
      /\.trace-pin__stack\s*>\s*\.trace-scope\[data-trace-kind="message"\]\s*\{[^}]*padding-left:\s*calc\(0\.85rem\s*\+\s*1\.35rem\)/s,
    )
    expect(css).toMatch(
      /\.trace-pin__stack\s*>\s*\.trace-scope\[data-trace-kind="sent"\]\s*,\s*\n\s*\.trace-pin__stack\s*>\s*\.trace-scope\[data-trace-kind="received"\]\s*\{[^}]*padding-left:\s*calc\(0\.85rem\s*\+\s*0\.55rem\)/s,
    )
  })

  it("work notes do not draw a top border on the first body row", () => {
    expect(css).toMatch(
      /\.trace-scope-body\s*>\s*\*\s*\+\s*\.trace-work-note\s*\{[^}]*border-top:/s,
    )
    const bare = css.match(/^\.trace-work-note\s*\{([^}]*)\}/m)
    expect(bare?.[1] ?? "").not.toMatch(/border-top/)
  })

  it("hides in-flow headers while pinned (replace contract)", () => {
    expect(css).toMatch(/\[data-trace-pinned\]\s*\{\s*visibility:\s*hidden/)
  })
})
