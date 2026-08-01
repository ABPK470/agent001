import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

describe("Pipelines time window parity", () => {
  it("toolbar exposes Event Stream quick range + From/Until", () => {
    const toolbar = readFileSync(join(here, "operation-log-toolbar.tsx"), "utf8")
    expect(toolbar).toContain("Quick range")
    expect(toolbar).toContain('label="From"')
    expect(toolbar).toContain('label="Until"')
    expect(toolbar).toContain("DateField")
  })

  it("client + store pass since/until", () => {
    const client = readFileSync(join(here, "../client/index.ts"), "utf8")
    const store = readFileSync(join(here, "../state/operations-store.ts"), "utf8")
    expect(client).toMatch(/operations:[\s\S]*since\?: string/)
    expect(client).toContain('params.set("since"')
    expect(client).toContain('params.set("until"')
    expect(store).toContain("resolveOperationsWindowBounds")
    expect(store).toContain("bounds.since")
    expect(store).toContain("bounds.until")
  })
})
