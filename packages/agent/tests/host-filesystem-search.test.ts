/**
 * Phase 4 item 4 — filesystem writes + search via the new AgentHost surface.
 *
 * Proves that:
 *   1. `createWriteFileTool(host)` writes under `host.filesystem.basePath`,
 *      auto-creates parent dirs, and refuses to escape the sandbox.
 *   2. `createAppendFileTool(host)` appends and refuses to escape.
 *   3. `createSearchFilesTool(host)` searches under `host.searchFiles.basePath`,
 *      respects `excludeDirs`, and rejects out-of-sandbox `path` args.
 *   4. Two hosts pointed at disjoint sandboxes remain isolated.
 *
 * See docs/doctrine.md and docs/runtime-inventory.md §7.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configureAgent } from "../src/application/shell/runtime.js"
import {
    createAppendFileTool,
    createWriteFileTool,
} from "../src/tools/filesystem/read-write.js"
import { createSearchFilesTool } from "../src/tools/search-files.js"

let sandboxA: string
let sandboxB: string

beforeEach(async () => {
  sandboxA = await mkdtemp(join(tmpdir(), "agent-host-fs-write-A-"))
  sandboxB = await mkdtemp(join(tmpdir(), "agent-host-fs-write-B-"))
})

afterEach(async () => {
  await rm(sandboxA, { recursive: true, force: true })
  await rm(sandboxB, { recursive: true, force: true })
})

// ── write_file ───────────────────────────────────────────────────

describe("createWriteFileTool — Phase 4 item 4", () => {
  it("writes a file under host.filesystem.basePath", async () => {
    const host = configureAgent({ filesystemBasePath: sandboxA })
    const tool = createWriteFileTool(host)

    const result = await tool.execute({ path: "notes/today.md", content: "# hello\n" })

    expect(typeof result === "object" ? (result as { ok: boolean }).ok : false).toBe(true)
    const written = await readFile(join(sandboxA, "notes/today.md"), "utf-8")
    expect(written).toBe("# hello\n")
  })

  it("rejects writes that escape the sandbox", async () => {
    const host = configureAgent({ filesystemBasePath: sandboxA })
    const tool = createWriteFileTool(host)

    const result = await tool.execute({ path: "../escape.txt", content: "nope" })

    expect(String(result === "string" ? result : JSON.stringify(result))).toMatch(/Error/i)
  })

  it("two hosts with different sandboxes do not see each other's writes", async () => {
    const hostA = configureAgent({ filesystemBasePath: sandboxA })
    const hostB = configureAgent({ filesystemBasePath: sandboxB })

    await createWriteFileTool(hostA).execute({ path: "a.txt", content: "from-A" })
    await createWriteFileTool(hostB).execute({ path: "b.txt", content: "from-B" })

    await expect(readFile(join(sandboxA, "b.txt"), "utf-8")).rejects.toThrow()
    await expect(readFile(join(sandboxB, "a.txt"), "utf-8")).rejects.toThrow()
    expect(await readFile(join(sandboxA, "a.txt"), "utf-8")).toBe("from-A")
    expect(await readFile(join(sandboxB, "b.txt"), "utf-8")).toBe("from-B")
  })
})

// ── append_file ──────────────────────────────────────────────────

describe("createAppendFileTool — Phase 4 item 4", () => {
  it("appends to an existing file under host.filesystem.basePath", async () => {
    await writeFile(join(sandboxA, "log.md"), "line1\n", "utf-8")
    const host = configureAgent({ filesystemBasePath: sandboxA })
    const tool = createAppendFileTool(host)

    await tool.execute({ path: "log.md", content: "line2\n" })

    expect(await readFile(join(sandboxA, "log.md"), "utf-8")).toBe("line1\nline2\n")
  })

  it("creates the file if it does not exist", async () => {
    const host = configureAgent({ filesystemBasePath: sandboxA })
    const tool = createAppendFileTool(host)

    await tool.execute({ path: "new.md", content: "first\n" })

    expect(await readFile(join(sandboxA, "new.md"), "utf-8")).toBe("first\n")
  })

  it("rejects appends that escape the sandbox", async () => {
    const host = configureAgent({ filesystemBasePath: sandboxA })
    const tool = createAppendFileTool(host)

    const result = await tool.execute({ path: "../escape.txt", content: "nope" })

    expect(typeof result === "string" ? result : JSON.stringify(result)).toMatch(/Error|rejected/i)
  })
})

// ── search_files ─────────────────────────────────────────────────

describe("createSearchFilesTool — Phase 4 item 4", () => {
  it("finds matches under host.searchFiles.basePath", async () => {
    await writeFile(join(sandboxA, "a.ts"), "const NEEDLE = 1\n", "utf-8")
    await writeFile(join(sandboxA, "b.ts"), "const other = 2\n", "utf-8")
    const host = configureAgent({ searchFilesBasePath: sandboxA })
    const tool = createSearchFilesTool(host)

    const result = await tool.execute({ pattern: "NEEDLE" }) as string

    expect(result).toContain("a.ts")
    expect(result).toContain("NEEDLE")
    expect(result).not.toContain("b.ts")
  })

  it("honours host.searchFiles.excludeDirs at the workspace root", async () => {
    await mkdir(join(sandboxA, "packages"), { recursive: true })
    await writeFile(join(sandboxA, "packages/x.ts"), "TARGET\n", "utf-8")
    await writeFile(join(sandboxA, "top.ts"), "TARGET\n", "utf-8")
    const host = configureAgent({
      searchFilesBasePath: sandboxA,
      searchFilesExcludeDirs: new Set(["packages"]),
    })
    const tool = createSearchFilesTool(host)

    const result = await tool.execute({ pattern: "TARGET" }) as string

    expect(result).toContain("top.ts")
    expect(result).not.toContain("packages/x.ts")
  })

  it("rejects path arguments that escape the search sandbox", async () => {
    const host = configureAgent({ searchFilesBasePath: sandboxA })
    const tool = createSearchFilesTool(host)

    const result = await tool.execute({ pattern: "anything", path: "../" }) as string

    expect(result).toMatch(/escapes the workspace/i)
  })

  it("two hosts pointed at different sandboxes do not cross-search", async () => {
    await writeFile(join(sandboxA, "a.ts"), "ONLY-A\n", "utf-8")
    await writeFile(join(sandboxB, "b.ts"), "ONLY-B\n", "utf-8")
    const hostA = configureAgent({ searchFilesBasePath: sandboxA })
    const hostB = configureAgent({ searchFilesBasePath: sandboxB })

    const [rA, rB] = await Promise.all([
      createSearchFilesTool(hostA).execute({ pattern: "ONLY-A" }) as Promise<string>,
      createSearchFilesTool(hostB).execute({ pattern: "ONLY-B" }) as Promise<string>,
    ])

    expect(rA).toContain("a.ts")
    expect(rB).toContain("b.ts")
    expect(rA).not.toContain("ONLY-B")
    expect(rB).not.toContain("ONLY-A")
  })
})
