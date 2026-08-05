import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "useStickToBottomScroll.ts"), "utf8")

describe("useStickToBottomScroll", () => {
  it("latches user engagement on scroll-away (does not clear on soft near-bottom)", () => {
    expect(src).toContain("userEngagedRef.current = true")
    expect(src).toContain("Still engaged away")
    // Soft near-bottom must not clear the inspect latch.
    expect(src).not.toMatch(
      /const near = isNearBottom[\s\S]*?if \(near\) \{\s*userEngagedRef\.current = false/,
    )
  })

  it("does not clear inspect latch when parallel fan-out ends", () => {
    const engage = src.match(
      /const engageFollowIfNearBottom = useCallback\(\(\) => \{[\s\S]*?\}, \[/,
    )?.[0]
    expect(engage).toBeTruthy()
    expect(engage).toContain("if (userEngagedRef.current) return")
    expect(engage).not.toContain("resumeAutoFollow()")
  })
})
