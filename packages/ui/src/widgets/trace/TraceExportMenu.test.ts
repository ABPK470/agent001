import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

describe("TraceExportMenu wiring", () => {
  it("TraceDag places download inside the fold segment track (trailing)", () => {
    const dagPath = join(dirname(fileURLToPath(import.meta.url)), "TraceDag.tsx")
    const src = readFileSync(dagPath, "utf8")
    expect(src).toMatch(/<SegmentToggle[\s\S]*trailing=\{[\s\S]*<TraceExportMenu/)
    expect(src).not.toMatch(
      /trace-toolbar__actions">\s*<TraceExportMenu/,
    )
  })

  it("export menu covers txt/json and no-code variants", () => {
    const menuPath = join(dirname(fileURLToPath(import.meta.url)), "TraceExportMenu.tsx")
    const src = readFileSync(menuPath, "utf8")
    expect(src).toContain('run("txt", false)')
    expect(src).toContain('run("json", false)')
    expect(src).toContain('run("txt", true)')
    expect(src).toContain('run("json", true)')
    expect(src).toContain("omitCode=1")
  })
})
