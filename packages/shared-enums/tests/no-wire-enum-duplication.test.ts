import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "vitest"
import * as shared from "../src/index.js"

const ROOT = resolve(__dirname, "../../..")
const SCAN_DIRS = ["packages/agent/src", "packages/server/src", "packages/ui/src"]
// Files that LEGITIMATELY re-export wire enums from @mia/shared-enums
// (façades) — exempt from drift detection.
const FACADE_WHITELIST = new Set([
  "packages/agent/src/engine/enums/run.ts",
  "packages/agent/src/engine/enums/step.ts",
  "packages/agent/src/engine/enums/event.ts",
  "packages/agent/src/engine/enums/planner-trace.ts",
  "packages/agent/src/engine/enums/agent-runtime.ts",
  "packages/agent/src/engine/enums/attachment.ts",
  "packages/agent/src/engine/enums/sync.ts",
  "packages/server/src/internal/enums/operations.ts",
  "packages/server/src/internal/enums/policy-source.ts",
  "packages/ui/src/enums/index.ts",
  "packages/ui/src/api.ts",
  "packages/ui/src/components/policy/selector-schema.ts",
  "packages/ui/src/types.ts"
])

const TS_EXT = /\.tsx?$/

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

/** Collect every (enumName, valueSet) pair exported from @mia/shared-enums. */
function collectWireEnums(): Array<{ name: string; values: Set<string> }> {
  const out: Array<{ name: string; values: Set<string> }> = []
  for (const [name, val] of Object.entries(shared)) {
    if (val == null || typeof val !== "object") continue
    const vals = Object.values(val as Record<string, unknown>)
    if (vals.length === 0) continue
    if (!vals.every((v) => typeof v === "string")) continue
    out.push({ name, values: new Set(vals as string[]) })
  }
  return out
}

describe("Lockdown — no wire-enum duplication outside @mia/shared-enums", () => {
  const wireEnums = collectWireEnums()

  test("no `as const` object in agent/server/ui re-declares a wire enum's value set", () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      const root = join(ROOT, dir)
      for (const file of walk(root)) {
        const rel = file.slice(ROOT.length + 1)
        if (FACADE_WHITELIST.has(rel)) continue
        const src = readFileSync(file, "utf8")
        // Capture every `export const NAME = { … } as const` block (loose).
        const blockRe = /export const (\w+)\s*=\s*\{([\s\S]*?)\}\s*as const/g
        let m: RegExpExecArray | null
        while ((m = blockRe.exec(src)) !== null) {
          const localName = m[1]
          const body = m[2]
          const stringValRe = /:\s*"([^"]+)"/g
          const localVals = new Set<string>()
          let v: RegExpExecArray | null
          while ((v = stringValRe.exec(body)) !== null) localVals.add(v[1])
          if (localVals.size === 0) continue
          for (const wire of wireEnums) {
            if (wire.values.size !== localVals.size) continue
            const matches = [...localVals].every((x) => wire.values.has(x))
            if (matches) {
              offenders.push(
                `${rel} :: const ${localName} duplicates @mia/shared-enums::${wire.name} ` +
                  `(${[...localVals].join(", ")})`
              )
            }
          }
        }
      }
    }
    expect(
      offenders,
      [
        "Found local enums whose value sets duplicate a wire enum already",
        "owned by @mia/shared-enums. Replace the local `as const` with a",
        "façade re-export from @mia/shared-enums to avoid BE↔FE drift.",
        "Offenders:",
        ...offenders.map((o) => "  " + o)
      ].join("\n")
    ).toEqual([])
  })
})
