import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const entityRegistryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "EntityRegistry.tsx",
)

describe("EntityRegistry notifications", () => {
  it("uses shared toast stack instead of inline banner notifications", () => {
    const src = readFileSync(entityRegistryPath, "utf8")
    expect(src).toContain('from "../components/useWidgetToasts"')
    expect(src).toContain("useWidgetToasts")
    expect(src).toContain("<ToastStack")
    expect(src).toContain('notify(`Published ${res.definitionCount} SyncDefinition(s)`)')
    expect(src).not.toContain("setToast")
    expect(src).not.toContain('aria-label="Dismiss"')
  })
})
