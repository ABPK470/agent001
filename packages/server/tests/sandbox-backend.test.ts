import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getSandboxBackend, resolveSandboxBackendKind } from "../src/sandbox/backend.js"

const created: string[] = []

async function createSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-backend-"))
  created.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe("sandbox backend", () => {
  it("defaults to host backend across operating systems", () => {
    const original = process.env["AGENT_SANDBOX_BACKEND"]
    delete process.env["AGENT_SANDBOX_BACKEND"]
    expect(resolveSandboxBackendKind()).toBe("host")
    if (original !== undefined) process.env["AGENT_SANDBOX_BACKEND"] = original
  })

  it("honours AGENT_SANDBOX_BACKEND=docker selection", () => {
    const original = process.env["AGENT_SANDBOX_BACKEND"]
    process.env["AGENT_SANDBOX_BACKEND"] = "docker"
    expect(resolveSandboxBackendKind()).toBe("docker")
    if (original === undefined) delete process.env["AGENT_SANDBOX_BACKEND"]
    else process.env["AGENT_SANDBOX_BACKEND"] = original
  })

  it("host backend is always available", async () => {
    expect(await getSandboxBackend("host").available()).toBe(true)
  })

  it("host backend executes commands inside the sandbox root", async () => {
    const sandbox = await createSandbox()
    const backend = getSandboxBackend("host")
    const isWindows = process.platform === "win32"
    const cmd = isWindows ? "cd" : "pwd"
    const result = await backend.exec(cmd, sandbox, { timeout: 5_000 })
    expect(result.exitCode).toBe(0)
    // Resolve via realpath-safe stat: the printed path should contain the
    // sandbox basename (handles macOS /private/var symlink prefix).
    const base = sandbox.split("/").pop() ?? sandbox
    expect(result.stdout).toContain(base)
  })

  it("host backend rejects cwd that escapes the sandbox root", async () => {
    const sandbox = await createSandbox()
    const backend = getSandboxBackend("host")
    await expect(backend.exec("echo nope", sandbox, { cwd: "../../../etc" })).rejects.toThrow(
      /escapes sandbox root/
    )
  })

  it("host backend writes inside the sandbox stay inside the sandbox", async () => {
    const sandbox = await createSandbox()
    const backend = getSandboxBackend("host")
    const isWindows = process.platform === "win32"
    const cmd = isWindows ? `echo hosted > ${join(sandbox, "marker.txt")}` : `printf 'hosted' > marker.txt`
    const result = await backend.exec(cmd, sandbox, { timeout: 5_000 })
    expect(result.exitCode).toBe(0)
    const info = await stat(join(sandbox, "marker.txt"))
    expect(info.isFile()).toBe(true)
  })
})
