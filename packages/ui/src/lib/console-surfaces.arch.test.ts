/**
 * Console role rail — one seam, no VISITOR_WIDGETS leftovers.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { canOpenWidget } from "@mia/shared-types"

const here = dirname(fileURLToPath(import.meta.url))
const packagesRoot = join(here, "../../..")

describe("console surface capability", () => {
  it("has no VISITOR_WIDGETS in UI or shared-types sources", () => {
    const shared = readFileSync(
      join(packagesRoot, "shared-types/src/index.ts"),
      "utf8",
    )
    const catalog = readFileSync(
      join(here, "../app/workspace/WidgetCatalog.tsx"),
      "utf8",
    )
    const summon = readFileSync(
      join(here, "../app/workspace/summon-items.ts"),
      "utf8",
    )
    expect(shared).not.toContain("VISITOR_WIDGETS")
    expect(shared).toContain("OPERATOR_WIDGETS")
    expect(shared).toContain("canOpenWidget")
    expect(catalog).not.toContain("VISITOR_WIDGETS")
    expect(catalog).toContain("canOpenWidget")
    expect(summon).toContain("canOpenWidget")
    expect(summon).toContain("spacesForRole")
  })

  it("Mymi is never openable", () => {
    expect(canOpenWidget("mymi-db", true)).toBe(false)
    expect(canOpenWidget("mymi-db", false)).toBe(false)
  })
})
