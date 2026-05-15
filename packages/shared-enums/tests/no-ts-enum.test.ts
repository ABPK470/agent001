import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "vitest"

const ROOT = resolve(__dirname, "../../..")
const SCAN_DIRS = [
  "packages/agent/src",
  "packages/server/src",
  "packages/ui/src",
  "packages/shared-enums/src",
]

const TS_EXT = /\.tsx?$/
const ENUM_RE = /^\s*export\s+enum\s+\w+/m

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue
      yield* walk(path)
    } else if (TS_EXT.test(name)) {
      yield path
    }
  }
}

describe("Lockdown — no TypeScript `enum` syntax", () => {
  test("every wire+internal enum uses the canonical `as const` pattern", () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      const root = join(ROOT, dir)
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8")
        if (ENUM_RE.test(src)) {
          const m = src.match(ENUM_RE)
          offenders.push(`${file.slice(ROOT.length + 1)}: ${m?.[0]?.trim()}`)
        }
      }
    }
    expect(offenders, [
      "Found `export enum ...` declarations. The codebase uses the",
      "`as const` object pattern instead — see `@mia/shared-enums` for the",
      "canonical shape. Wire-format enums must live in `@mia/shared-enums`",
      "and be re-exported from package barrels as façades.",
      "Offenders:",
      ...offenders.map((o) => "  " + o),
    ].join("\n")).toEqual([])
  })
})
