import { describe, expect, it } from "vitest"
import { buildSpaceView, PRODUCT_SPACES } from "../../lib/spaces"
import { leafNode } from "../../lib/split-tree"
import type { WorkspaceView } from "../../lib/workspace-view"
import { Brain } from "lucide-react"
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
  it("orders Spaces → presets → surfaces when a Space drifted", () => {
    const items = listSummonItems({
      views: defaultProductViews().map((view) =>
        view.id === "space:observe" ? pollutedObserve() : view,
      ),
    })
    const kinds = items.map((item) => item.kind)
    const firstWidget = kinds.indexOf("widget")
    const lastSpace = kinds.lastIndexOf("space")
    const lastBundle = kinds.lastIndexOf("bundle")
    expect(lastSpace).toBeLessThan(kinds.indexOf("bundle"))
    expect(lastBundle).toBeLessThan(firstWidget)
  })

  it("hides reset presets when every product Space is at default", () => {
    const items = listSummonItems({ views: defaultProductViews() })
    expect(items.some((item) => item.kind === "bundle")).toBe(false)
  })

  it("shows only the reset preset for the drifted Space", () => {
    const items = listSummonItems({
      views: defaultProductViews().map((view) =>
        view.id === "space:observe" ? pollutedObserve() : view,
      ),
    })
    const bundles = items.filter((item) => item.kind === "bundle")
    expect(bundles).toHaveLength(1)
    expect(bundles[0]).toMatchObject({ id: "bundle:observe-core" })
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
    const items = listSummonItems({ views })
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

  it("lists every catalog surface including Trace, Bridge, and Users", () => {
    const items = listSummonItems({ views: defaultProductViews() })
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

  it("previews keep for Trace surface (stays on current layout)", () => {
    const trace = listSummonItems({ views: defaultProductViews() }).find(
      (item) => item.kind === "widget" && item.type === "debug-inspector",
    )!
    expect(summonActionPreview(trace, { onSpace: false, spaceName: null }).primary).toBe("keep")
  })

  it("previews keep vs focus for widgets", () => {
    const widget = listSummonItems({ views: defaultProductViews() }).find(
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
    const items = listSummonItems({ views: defaultProductViews() })
    const hit = filterSummonItems("observe", items)
    expect(hit.some((item) => item.kind === "space" && item.name === "Observe")).toBe(true)
  })
})
