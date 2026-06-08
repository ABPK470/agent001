/**
 * Phase 3 pilot — read_file via the new AgentHost surface.
 *
 * Proves the doctrine path works end-to-end:
 *   1. Build a host with `configureAgent({ filesystemBasePath })` — no
 *      ambient state, no setters, no runtime fallback.
 *   2. Build the read_file tool with `createReadFileTool(host)`.
 *   3. The tool reads files from the host-provided base path, rejects
 *      escapes, and produces the same outputs as the legacy ambient
 *      `readFileTool`.
 *
 * See docs/doctrine.md and docs/runtime-inventory.md.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { configureAgent } from "../src/application/shell/runtime.js"
import { createReadFileTool } from "../src/tools/filesystem/read-write.js"

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-host-read-file-"))
  await writeFile(join(tempDir, "hello.txt"), "hello from host\n", "utf-8")
  await writeFile(join(tempDir, "nested-dir-marker"), "x", "utf-8")
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe("createReadFileTool — Phase 3 pilot", () => {
  it("reads a file via an explicit AgentHost (no ambient state)", async () => {
    const host = configureAgent({ filesystemBasePath: tempDir })
    const tool = createReadFileTool(host)

    const result = await tool.execute({ path: "hello.txt" })

    expect(result).toBe("hello from host\n")
  })

  it("rejects paths that escape the host's basePath", async () => {
    const host = configureAgent({ filesystemBasePath: tempDir })
    const tool = createReadFileTool(host)

    const result = await tool.execute({ path: "../escape.txt" })

    expect(String(result)).toMatch(/Error:/)
    expect(String(result)).toMatch(/traversal|escapes|allowed/i)
  })

  it("returns a friendly ENOTDIR message when a path component is a file", async () => {
    const host = configureAgent({ filesystemBasePath: tempDir })
    const tool = createReadFileTool(host)

    // nested-dir-marker is a regular file; treating it as a directory
    // must produce the doctrine ENOTDIR hint, not a raw errno string.
    const result = await tool.execute({ path: "nested-dir-marker/child.txt" })

    expect(String(result)).toMatch(/parent directory/)
  })

  it("two hosts with different basePaths are isolated (no shared ambient state)", async () => {
    const otherDir = await mkdtemp(join(tmpdir(), "agent-host-read-file-other-"))
    try {
      await writeFile(join(otherDir, "hello.txt"), "hello from OTHER host\n", "utf-8")

      const hostA = configureAgent({ filesystemBasePath: tempDir })
      const hostB = configureAgent({ filesystemBasePath: otherDir })

      const toolA = createReadFileTool(hostA)
      const toolB = createReadFileTool(hostB)

      const [a, b] = await Promise.all([
        toolA.execute({ path: "hello.txt" }),
        toolB.execute({ path: "hello.txt" })
      ])

      expect(a).toBe("hello from host\n")
      expect(b).toBe("hello from OTHER host\n")
    } finally {
      await rm(otherDir, { recursive: true, force: true })
    }
  })
})
