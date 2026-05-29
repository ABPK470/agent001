/**
 * HostSandboxBackend — process-group containment + env hardening.
 *
 * Locks the Phase 1A guarantees:
 *   1. A timed-out command's child processes die with their parent (no
 *      orphaned descendants leaking past the timeout) on POSIX.
 *   2. Outbound proxy hints are stripped when `network: false` (default)
 *      so tools can't stealthily route around a network deny.
 *   3. `network: true` forwards proxy hints unchanged.
 *
 * These are the OS-agnostic pieces. Windows job-object containment lives
 * in the same backend file but only fires under `process.platform ===
 * "win32"`; we skip the timeout-kill assertion on Windows since the kill
 * mechanism (`taskkill /F /T`) is not deterministically observable from
 * a unit test on macOS/Linux CI.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getSandboxBackend } from "../src/sandbox/backend.js"

const created: string[] = []

async function createSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-isolation-"))
  created.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

const isPosix = process.platform !== "win32"

describe("HostSandboxBackend — timeout-kill and env hardening", () => {
  it.runIf(isPosix)(
    "kills the entire process tree when the timeout elapses (no descendant survives)",
    async () => {
      const sandbox = await createSandbox()
      const stamp = join(sandbox, "child.txt")
      // Spawn a parent shell that itself spawns a long-lived background
      // child. If we only kill the parent, the orphaned descendant writes
      // the stamp 4s later. With process-group kill it never gets there.
      //
      // Generous timings so the assertion isn't a CI-load race:
      //   - parent runs `sleep 10` (so it can't naturally exit before we kill it)
      //   - descendant sleeps 8s before writing
      //   - we time out the parent at 1500ms (well after spawn settles)
      //   - then wait 9s before asserting the stamp was never written
      const cmd = `( sleep 8; printf alive > ${JSON.stringify(stamp)} ) & echo started; sleep 15`
      const backend = getSandboxBackend("host")
      const t0 = Date.now()
      const result = await backend.exec(cmd, sandbox, { timeout: 1_500 })
      const elapsed = Date.now() - t0
      expect(result.timedOut).toBe(true)
      // Should die soon after the timeout, not at the parent's natural 10s.
      expect(elapsed).toBeLessThan(5_000)
      await new Promise((r) => setTimeout(r, 9_000))
      let descendantRan = false
      try {
        const { readFile } = await import("node:fs/promises")
        await readFile(stamp, "utf8")
        descendantRan = true
      } catch { /* expected: file never created */ }
      expect(descendantRan).toBe(false)
    },
    25_000,
  )

  it("strips HTTP/HTTPS proxy env vars when network is not opted-in (default)", async () => {
    const sandbox = await createSandbox()
    const backend = getSandboxBackend("host")
    // Caller passes a forged proxy var via options.env; backend must
    // drop it before spawning the shell.
    const cmd = isPosix
      ? `printf '%s|%s' "$HTTP_PROXY" "$HTTPS_PROXY"`
      : `echo %HTTP_PROXY%^|%HTTPS_PROXY%`
    const result = await backend.exec(cmd, sandbox, {
      env: { HTTP_PROXY: "http://evil:3128", HTTPS_PROXY: "http://evil:3128", PATH: process.env["PATH"] ?? "" },
    })
    expect(result.exitCode).toBe(0)
    // POSIX prints empty|empty; cmd.exe prints `|` literally because
    // unset vars become empty. Either way the proxy strings must be gone.
    expect(result.stdout).not.toContain("evil:3128")
  })

  it("forwards proxy env vars when network is explicitly allowed", async () => {
    const sandbox = await createSandbox()
    const backend = getSandboxBackend("host")
    const cmd = isPosix ? `printf '%s' "$HTTP_PROXY"` : `echo %HTTP_PROXY%`
    const result = await backend.exec(cmd, sandbox, {
      network: true,
      env: { HTTP_PROXY: "http://allowed-proxy:3128", PATH: process.env["PATH"] ?? "" },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("allowed-proxy:3128")
  })

  it("captures stdout from a normal command and reports exitCode=0", async () => {
    const sandbox = await createSandbox()
    await writeFile(join(sandbox, "marker.txt"), "ok")
    const backend = getSandboxBackend("host")
    const cmd = isPosix ? `cat marker.txt` : `type marker.txt`
    const result = await backend.exec(cmd, sandbox)
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.trim()).toBe("ok")
  })
})
