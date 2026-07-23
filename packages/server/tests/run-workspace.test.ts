import { PolicyRole } from "@mia/agent"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  applyWorkspaceDiff,
  classifyRunTaskType,
  cleanupStaleRunWorkspaces,
  computeWorkspaceDiff,
  getRunProfile,
  getRunWorkspaceRoot,
  prepareRunWorkspace,
  shouldUseIsolatedWorkspace
} from "../src/runtime/workspace/index.js"

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

  it("marks source-only artifacts as deleted when the sandbox never received them", async () => {
    const sourceRoot = await createTempDir("leak-source-")
    const execRoot = await createTempDir("leak-exec-")

    await writeFile(join(sourceRoot, "README.md"), "# workspace\n")
    await writeFile(join(execRoot, "README.md"), "# workspace\n")
    // Simulates the pre-fix bug: write_file targeted sourceRoot instead of the
    // isolated execution copy, so the new app exists only in the real workspace.
    await mkdir(join(sourceRoot, "pong"), { recursive: true })
    await writeFile(join(sourceRoot, "pong/index.html"), "<html></html>\n")

    const diff = await computeWorkspaceDiff(sourceRoot, execRoot)
    expect(diff.added).toEqual([])
    expect(diff.deleted).toEqual(["pong/index.html"])

    await applyWorkspaceDiff({ sourceRoot, executionRoot: execRoot, diff })
    let exists = true
    try {
      await stat(join(sourceRoot, "pong/index.html"))
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it("promotes sandbox-only artifacts into the source tree on apply", async () => {
    const sourceRoot = await createTempDir("promote-source-")
    const execRoot = await createTempDir("promote-exec-")

    await writeFile(join(sourceRoot, "README.md"), "# workspace\n")
    await writeFile(join(execRoot, "README.md"), "# workspace\n")
    await mkdir(join(execRoot, "pong"), { recursive: true })
    await writeFile(join(execRoot, "pong/index.html"), "<html></html>\n")

    const diff = await computeWorkspaceDiff(sourceRoot, execRoot)
    expect(diff.added).toEqual(["pong/index.html"])
    expect(diff.deleted).toEqual([])

    await applyWorkspaceDiff({ sourceRoot, executionRoot: execRoot, diff })
    const promoted = await readFile(join(sourceRoot, "pong/index.html"), "utf8")
    expect(promoted).toContain("<html>")
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

  describe("hosted run profile", () => {
    const ORIGINAL_HOSTED = process.env["AGENT_HOSTED_MODE"]

    afterEach(() => {
      if (ORIGINAL_HOSTED === undefined) {
        delete process.env["AGENT_HOSTED_MODE"]
      } else {
        process.env["AGENT_HOSTED_MODE"] = ORIGINAL_HOSTED
      }
    })

    it("reports developer profile by default", () => {
      delete process.env["AGENT_HOSTED_MODE"]
      expect(getRunProfile()).toBe("developer")
    })

    it("reports hosted profile when AGENT_HOSTED_MODE=true", () => {
      process.env["AGENT_HOSTED_MODE"] = "true"
      expect(getRunProfile()).toBe("hosted")
      expect(shouldUseIsolatedWorkspace("Summarize architecture decisions", false)).toBe(true)
    })

    it("forces an empty isolated sandbox in hosted profile and never copies source", async () => {
      const sourceRoot = await createTempDir("hosted-source-")
      await mkdir(join(sourceRoot, "src"), { recursive: true })
      await writeFile(join(sourceRoot, "src", "secret.ts"), "export const s = 1\n")
      await writeFile(join(sourceRoot, "README.md"), "# real workspace\n")

      // Isolation is gated by `role` (the security boundary), not by
      // `profile` or AGENT_HOSTED_MODE. See run-workspace.ts: HostedUser
      // role always gets an empty sandbox, Admin role never does —
      // regardless of deployment env. The deprecated `profile` param
      // only feeds the legacy admin-codegen copy path.
      const ctx = await prepareRunWorkspace({
        runId: "run-hosted-1",
        sourceRoot,
        goal: "Read MSSQL stats", // analysis-style goal; would normally not isolate
        resume: false,
        role: PolicyRole.HostedUser
      })
      createdDirs.push(ctx.executionRoot)

      expect(ctx.profile).toBe("hosted")
      expect(ctx.isolated).toBe(true)
      expect(ctx.executionRoot).not.toBe(sourceRoot)

      // Sandbox must be empty: no source bytes leaked in.
      let leaked = false
      try {
        await stat(join(ctx.executionRoot, "src", "secret.ts"))
        leaked = true
      } catch {
        /* expected */
      }
      expect(leaked).toBe(false)

      let readmeLeaked = false
      try {
        await stat(join(ctx.executionRoot, "README.md"))
        readmeLeaked = true
      } catch {
        /* expected */
      }
      expect(readmeLeaked).toBe(false)
    })

    it("isolates hosted runs even on resume", async () => {
      const sourceRoot = await createTempDir("hosted-resume-")
      const ctx = await prepareRunWorkspace({
        runId: "run-hosted-resume",
        sourceRoot,
        goal: "follow up question",
        resume: true,
        role: PolicyRole.HostedUser
      })
      createdDirs.push(ctx.executionRoot)
      expect(ctx.isolated).toBe(true)
      expect(ctx.executionRoot).not.toBe(sourceRoot)
    })
  })
})
