import { describe, expect, it } from "vitest"
import { buildSpaceView, PRODUCT_SPACES } from "../../lib/spaces"
import { leafNode } from "../../lib/split-tree"
import type { WorkspaceView } from "../../lib/workspace-view"
import { Brain, LayoutPanelLeft } from "lucide-react"
import {
  filterSummonItems,
  listSummonItems,
  summonActionPreview,
  summonItemIcon,
  summonItemIconType,
  widgetSummonGroup,
} from "./summon-items"

function defaultProductViews(): WorkspaceView[] {
  return PRODUCT_SPACES.map((def) => buildSpaceView(def))
}

function pollutedObserve(): WorkspaceView {
  const observe = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:observe")!)
  return {
    ...observe,
    tiles: observe.tiles.slice(0, 1),
    split: leafNode(observe.tiles[0]!.id),
  }
}

describe("summon catalog", () => {
  it("lists custom DIY layouts after product Spaces", () => {
    const diy: WorkspaceView = {
      id: "layout-iq9p",
      name: "Layout iq9p",
      tiles: [
        {
          id: "t1",
          type: "thread-nav",
          x: 0,
          y: 0,
          w: 12,
          h: 12,
          minW: 4,
          minH: 4,
        },
      ],
      split: leafNode("t1"),
    }
    const items = listSummonItems({
      views: [...defaultProductViews(), diy],
      isAdmin: true,
    })
    const custom = items.find(
      (item) => item.kind === "space" && item.id === "layout-iq9p",
    )
    expect(custom).toMatchObject({
      kind: "space",
      name: "Layout iq9p",
      custom: true,
      index: 0,
      primaryType: "thread-nav",
    })
    const spaceIds = items
      .filter((item) => item.kind === "space")
      .map((item) => item.id)
    expect(spaceIds.indexOf("space:users")).toBeLessThan(
      spaceIds.indexOf("layout-iq9p"),
    )
    // Custom layouts keep LayoutPanelLeft — never borrow a surface glyph.
    expect(custom && summonItemIcon(custom)).toBe(LayoutPanelLeft)
    expect(custom && summonItemIconType(custom)).toBe("layout")
  })

  it("orders Spaces → presets → surfaces when a Space drifted", () => {
    const items = listSummonItems({
      views: defaultProductViews().map((view) =>
        view.id === "space:observe" ? pollutedObserve() : view,
      ),
      isAdmin: true,
    })
    const kinds = items.map((item) => item.kind)
    const firstWidget = kinds.indexOf("widget")
    const lastSpace = kinds.lastIndexOf("space")
    const lastBundle = kinds.lastIndexOf("bundle")
    expect(lastSpace).toBeLessThan(kinds.indexOf("bundle"))
    expect(lastBundle).toBeLessThan(firstWidget)
  })

  it("hides reset presets when every product Space is at default", () => {
    const items = listSummonItems({ views: defaultProductViews(), isAdmin: true })
    expect(items.some((item) => item.kind === "bundle")).toBe(false)
  })

  it("shows only the reset preset for the drifted Space", () => {
    const items = listSummonItems({
      views: defaultProductViews().map((view) =>
        view.id === "space:observe" ? pollutedObserve() : view,
      ),
      isAdmin: true,
    })
    const bundles = items.filter((item) => item.kind === "bundle")
    expect(bundles).toHaveLength(1)
    expect(bundles[0]).toMatchObject({ id: "bundle:observe-core" })
  })

  it("tracks Bridge and Trace drift with reset presets (same as Observe / Agent)", () => {
    const views = defaultProductViews().map((view) => {
      if (view.id === "space:bridge") {
        return {
          ...view,
          tiles: [
            ...view.tiles,
            {
              id: "extra-bridge",
              type: "live-logs" as const,
              x: 0,
              y: 0,
              w: 6,
              h: 12,
              minW: 2,
              minH: 4,
            },
          ],
        }
      }
      if (view.id === "space:trace") {
        return {
          ...view,
          tiles: [
            ...view.tiles,
            {
              id: "extra-trace",
              type: "term-chat" as const,
              x: 0,
              y: 0,
              w: 6,
              h: 12,
              minW: 2,
              minH: 4,
            },
          ],
        }
      }
      return view
    })
    const bundles = listSummonItems({ views, isAdmin: true }).filter(
      (item) => item.kind === "bundle",
    )
    expect(bundles.map((item) => item.id).sort()).toEqual([
      "bundle:bridge-core",
      "bundle:trace-core",
    ])
  })

  it("groups agent surfaces together", () => {
    expect(widgetSummonGroup("debug-inspector")).toBe("agent")
    expect(widgetSummonGroup("operation-log")).toBe("platform")
    expect(widgetSummonGroup("env-sync")).toBe("config")
  })

  it("Agent uses Brain; Trace keeps Bug; presets match focus surface", () => {
    const views = defaultProductViews().map((view) =>
      view.id === "space:observe" ? pollutedObserve() : view,
    )
    const items = listSummonItems({ views, isAdmin: true })
    const agent = items.find((item) => item.kind === "space" && item.id === "space:agent")!
    const trace = items.find((item) => item.kind === "space" && item.id === "space:trace")!
    const users = items.find((item) => item.kind === "space" && item.id === "space:users")!
    const observeReset = items.find(
      (item) => item.kind === "bundle" && item.id === "bundle:observe-core",
    )!
    const chat = items.find(
      (item) => item.kind === "widget" && item.type === "term-chat",
    )!
    expect(summonItemIcon(agent)).toBe(Brain)
    expect(summonItemIconType(agent)).toBe("agent-brain")
    expect(summonItemIconType(trace)).toBe("debug-inspector")
    expect(summonItemIconType(users)).toBe("active-users")
    expect(summonItemIconType(observeReset)).toBe("operation-log")
    expect(summonItemIconType(chat)).toBe("term-chat")
  })

  it("admin Summon includes Trace, Bridge, and Users", () => {
    const items = listSummonItems({ views: defaultProductViews(), isAdmin: true })
    const widgets = items.filter((item) => item.kind === "widget")
    expect(widgets.some((item) => item.kind === "widget" && item.type === "debug-inspector")).toBe(
      true,
    )
    expect(widgets.some((item) => item.kind === "widget" && item.type === "bridge")).toBe(true)
    expect(widgets.some((item) => item.kind === "widget" && item.type === "active-users")).toBe(
      true,
    )
    expect(items.some((item) => item.kind === "space" && item.id === "space:trace")).toBe(true)
    expect(items.some((item) => item.kind === "space" && item.id === "space:users")).toBe(true)
  })

  it("operator Summon excludes Platform control-plane and Mymi", () => {
    const items = listSummonItems({ views: defaultProductViews(), isAdmin: false })
    const widgetTypes = items
      .filter((item) => item.kind === "widget")
      .map((item) => (item.kind === "widget" ? item.type : ""))
    expect(widgetTypes).toContain("debug-inspector")
    expect(widgetTypes).toContain("env-sync")
    expect(widgetTypes).not.toContain("bridge")
    expect(widgetTypes).not.toContain("active-users")
    expect(widgetTypes).not.toContain("entity-registry")
    expect(widgetTypes).not.toContain("sync-admin")
    expect(widgetTypes).not.toContain("mymi-db")
    expect(items.some((item) => item.kind === "space" && item.id === "space:bridge")).toBe(false)
    expect(items.some((item) => item.kind === "space" && item.id === "space:users")).toBe(false)
    expect(items.some((item) => item.kind === "space" && item.id === "space:reconcile")).toBe(true)
  })

  it("previews keep for Trace surface (stays on current layout)", () => {
    const trace = listSummonItems({ views: defaultProductViews(), isAdmin: true }).find(
      (item) => item.kind === "widget" && item.type === "debug-inspector",
    )!
    expect(summonActionPreview(trace, { onSpace: false, spaceName: null }).primary).toBe("keep")
  })

  it("previews keep vs focus for widgets", () => {
    const widget = listSummonItems({ views: defaultProductViews(), isAdmin: true }).find(
      (item) => item.kind === "widget" && item.type === "operation-log",
    )!
    expect(summonActionPreview(widget, { onSpace: false, spaceName: "Agent" }).primary).toBe(
      "keep",
    )
    expect(summonActionPreview(widget, { onSpace: true, spaceName: "Agent" }).primary).toBe(
      "focus",
    )
  })

  it("filters across name and kind", () => {
    const items = listSummonItems({ views: defaultProductViews(), isAdmin: true })
    const hit = filterSummonItems("observe", items)
    expect(hit.some((item) => item.kind === "space" && item.name === "Observe")).toBe(true)
  })

  it("does not match surfaces via peer names in desc (trace ≠ Threads)", () => {
    const items = listSummonItems({ views: defaultProductViews(), isAdmin: true })
    const hit = filterSummonItems("trace", items)
    expect(hit.some((item) => item.kind === "widget" && item.type === "debug-inspector")).toBe(true)
    expect(hit.some((item) => item.kind === "space" && item.id === "space:trace")).toBe(true)
    expect(hit.some((item) => item.kind === "widget" && item.type === "thread-nav")).toBe(false)
    expect(hit.some((item) => item.name === "Threads")).toBe(false)
  })
})
