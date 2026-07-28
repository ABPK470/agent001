import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "VirtualList.tsx"),
  "utf8",
)

describe("VirtualList sticky contract", () => {
  it("positions rows with top — never transform (CSS sticky-safe)", () => {
    expect(src).toMatch(/top:\s*virtualRow\.start/)
    expect(src).not.toMatch(/transform:\s*`translateY/)
    expect(src).toMatch(/never `transform`/)
  })
})
