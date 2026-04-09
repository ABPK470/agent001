import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
    applyWorkspaceDiff,
    classifyRunTaskType,
    cleanupStaleRunWorkspaces,
    computeWorkspaceDiff,
    getRunWorkspaceRoot,
    shouldUseIsolatedWorkspace,
} from "../src/run-workspace.js"

const createdDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe("run-workspace", () => {
  it("classifies code generation goals for isolation", () => {
    expect(classifyRunTaskType("Implement new auth middleware and update tests")).toBe("code_generation")
    expect(classifyRunTaskType("Summarize architecture decisions from docs")).toBe("analysis_or_chat")
  })

  it("disables isolation for resumed runs", () => {
    expect(shouldUseIsolatedWorkspace("Implement API endpoint", true)).toBe(false)
    expect(shouldUseIsolatedWorkspace("Implement API endpoint", false)).toBe(true)
  })

  it("computes and applies workspace diffs", async () => {
    const sourceRoot = await createTempDir("source-")
    const execRoot = await createTempDir("exec-")

    await mkdir(join(sourceRoot, "src"), { recursive: true })
    await mkdir(join(execRoot, "src"), { recursive: true })

    await writeFile(join(sourceRoot, "src", "keep.ts"), "export const a = 1\n")
    await writeFile(join(sourceRoot, "src", "remove.ts"), "export const removeMe = true\n")

    await writeFile(join(execRoot, "src", "keep.ts"), "export const a = 2\n")
    await writeFile(join(execRoot, "src", "added.ts"), "export const added = true\n")

    const diff = await computeWorkspaceDiff(sourceRoot, execRoot)
    expect(diff.added).toEqual(["src/added.ts"])
    expect(diff.modified).toEqual(["src/keep.ts"])
    expect(diff.deleted).toEqual(["src/remove.ts"])

    const summary = await applyWorkspaceDiff({ sourceRoot, executionRoot: execRoot, diff })
    expect(summary).toEqual({ added: 1, modified: 1, deleted: 1 })

    const keep = await readFile(join(sourceRoot, "src", "keep.ts"), "utf8")
    const added = await readFile(join(sourceRoot, "src", "added.ts"), "utf8")

    expect(keep).toContain("= 2")
    expect(added).toContain("added")

    const postDiff = await computeWorkspaceDiff(sourceRoot, execRoot)
    expect(postDiff.added).toHaveLength(0)
    expect(postDiff.modified).toHaveLength(0)
    expect(postDiff.deleted).toHaveLength(0)
  })

  it("cleans stale isolated workspace directories", async () => {
    const root = getRunWorkspaceRoot()
    await mkdir(root, { recursive: true })
    const staleDir = await mkdtemp(join(root, "stale-run-"))

    const removed = await cleanupStaleRunWorkspaces(-1)
    expect(removed).toBeGreaterThanOrEqual(1)

    let exists = true
    try {
      await stat(staleDir)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})
