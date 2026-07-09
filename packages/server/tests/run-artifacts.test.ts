import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import {
  listRunArtifactFiles,
  openRunArtifactStream,
  resolveRunArtifactFile,
} from "../src/features/runs/run-artifacts.js"

describe("run artifacts", () => {
  const root = join(tmpdir(), `mia-artifacts-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "report.csv"), "a,b\n1,2\n")
  mkdirSync(join(root, "nested"))
  writeFileSync(join(root, "nested", "out.txt"), "hello")

  it("rejects path traversal", () => {
    expect(resolveRunArtifactFile(root, "../secret")).toBeNull()
    expect(resolveRunArtifactFile(root, "nested/../../etc/passwd")).toBeNull()
  })

  it("lists sandbox files relative to execution root", async () => {
    const files = await listRunArtifactFiles(root)
    expect(files.map((f) => f.path).sort()).toEqual(["nested/out.txt", "report.csv"])
  })

  it("opens a readable file stream", async () => {
    const opened = await openRunArtifactStream(root, "report.csv")
    expect(opened).not.toBeNull()
    expect(opened?.filename).toBe("report.csv")
    expect(opened?.sizeBytes).toBeGreaterThan(0)
  })
})
