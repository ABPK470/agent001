/**
 * Phase 4 items 5 + 6 — shell + browser-check via the AgentHost surface.
 *
 * Proves that:
 *   1. `createShellTool(host)` routes commands through `host.shell.client`
 *      with the configured `cwd` and respects the deny list.
 *   2. `sandboxStrict` toggles which deny rules apply.
 *   3. `createBrowserCheckTool(host)` rejects out-of-sandbox paths, surfaces
 *      "file not found" errors, and routes to `host.browserCheck.client`
 *      when set.
 *   4. Two hosts pointed at disjoint sandboxes remain isolated.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configureAgent } from "../src/host/index.js"
import type { BrowserCheckResult, ShellExecResult } from "../src/host/ports.js"
import { createBrowserCheckTool } from "../src/tools/browser-check/index.js"
import { createShellTool } from "../src/tools/shell/index.js"

let sandboxA: string
let sandboxB: string

beforeEach(async () => {
  sandboxA = await mkdtemp(join(tmpdir(), "agent-host-shell-A-"))
  sandboxB = await mkdtemp(join(tmpdir(), "agent-host-shell-B-"))
})

afterEach(async () => {
  await rm(sandboxA, { recursive: true, force: true })
  await rm(sandboxB, { recursive: true, force: true })
})

// ── createShellTool ──────────────────────────────────────────────

describe("createShellTool — Phase 4 item 5", () => {
  it("routes commands through host.shell.client with configured cwd", async () => {
    const exec = vi.fn(async (_cmd: string, _cwd: string): Promise<ShellExecResult> => ({
      stdout: "hi",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      sandboxed: true,
    }))
    const host = configureAgent({ shellCwd: sandboxA, shellClient: exec })
    const tool = createShellTool(host)

    const result = await tool.execute({ command: "echo hi" })

    expect(exec).toHaveBeenCalledWith("echo hi", sandboxA, undefined)
    expect(String(result)).toContain("hi")
  })

  it("blocks deny-listed commands without invoking the executor", async () => {
    const exec = vi.fn()
    const host = configureAgent({ shellCwd: sandboxA, shellClient: exec as never })
    const tool = createShellTool(host)

    const result = await tool.execute({ command: "rm -rf /" })

    expect(exec).not.toHaveBeenCalled()
    expect(String(result)).toMatch(/blocked/i)
  })

  it("sandboxStrict=true skips host-only deny rules", async () => {
    const exec = vi.fn(async (): Promise<ShellExecResult> => ({
      stdout: "ok", stderr: "", exitCode: 0, timedOut: false, sandboxed: true,
    }))
    const host = configureAgent({
      shellCwd: sandboxA,
      shellClient: exec,
      shellSandboxStrict: true,
    })
    const tool = createShellTool(host)

    // sudo is a host-only rule; in strict sandbox mode it should NOT block.
    await tool.execute({ command: "sudo echo hi" })

    expect(exec).toHaveBeenCalled()
  })

  it("two hosts with different cwds remain isolated", async () => {
    const execA = vi.fn(async (_c: string, _w: string): Promise<ShellExecResult> => ({
      stdout: "A", stderr: "", exitCode: 0, timedOut: false, sandboxed: true,
    }))
    const execB = vi.fn(async (_c: string, _w: string): Promise<ShellExecResult> => ({
      stdout: "B", stderr: "", exitCode: 0, timedOut: false, sandboxed: true,
    }))
    const hostA = configureAgent({ shellCwd: sandboxA, shellClient: execA })
    const hostB = configureAgent({ shellCwd: sandboxB, shellClient: execB })

    await createShellTool(hostA).execute({ command: "pwd" })
    await createShellTool(hostB).execute({ command: "pwd" })

    expect(execA).toHaveBeenCalledWith("pwd", sandboxA, undefined)
    expect(execB).toHaveBeenCalledWith("pwd", sandboxB, undefined)
  })
})

// ── createBrowserCheckTool ───────────────────────────────────────

describe("createBrowserCheckTool — Phase 4 item 6", () => {
  it("rejects out-of-sandbox paths", async () => {
    const host = configureAgent({ browserCheckCwd: sandboxA })
    const tool = createBrowserCheckTool(host)

    const result = await tool.execute({ path: "../escape.html" })

    expect(String(result)).toMatch(/outside|escape|invalid/i)
  })

  it("surfaces missing-file errors clearly", async () => {
    const host = configureAgent({ browserCheckCwd: sandboxA })
    const tool = createBrowserCheckTool(host)

    const result = await tool.execute({ path: "missing.html" })

    expect(String(result)).toMatch(/not found|missing|enoent/i)
  })

  it("routes through host.browserCheck.client when set", async () => {
    const fixture = join(sandboxA, "page.html")
    await writeFile(fixture, "<html><body>hi</body></html>", "utf-8")

    const client = vi.fn(
      async (_html: string, _clicks: string[], _wait: number, _cwd: string): Promise<BrowserCheckResult> => ({
        report: "OK from sandbox",
        sandboxed: true,
      }),
    )
    const host = configureAgent({
      browserCheckCwd: sandboxA,
      browserCheckClient: client,
    })
    const tool = createBrowserCheckTool(host)

    const result = await tool.execute({ path: "page.html" })

    expect(client).toHaveBeenCalled()
    expect(String(result)).toContain("OK from sandbox")
  })
})
