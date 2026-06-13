import type { BrowserClient, ShellClient } from "@mia/agent"
import { buildBrowserScript, formatBrowserReport } from "../features/browser/application/helpers.js"
import { type DockerSandbox, initSandbox } from "../platform/sandbox/index.js"

export interface SandboxRuntime {
  readonly sandbox: DockerSandbox
  readonly shellClient: ShellClient | null
  readonly shellSandboxStrict: boolean
  readonly browserCheckMode: "host" | "sandbox"
  readonly browserCheckClient: BrowserClient | null
}

export async function configureSandbox(getWorkspace: () => string): Promise<SandboxRuntime> {
  const sandboxMode =
    process.env["SANDBOX_MODE"] === "host"
      ? ("host" as const)
      : process.env["SANDBOX_MODE"] === "all"
        ? ("all" as const)
        : ("docker" as const)
  const sandbox = initSandbox({ mode: sandboxMode })
  const dockerReady = await sandbox.isDockerAvailable()

  let shellClient: ShellClient | null = null
  let shellSandboxStrict = false
  let browserCheckMode: "host" | "sandbox" = "host"
  let browserCheckClient: BrowserClient | null = null

  if (dockerReady && sandbox.mode !== "host") {
    shellClient = async (command, cwd, signal) => {
      return sandbox.exec(command, cwd || getWorkspace(), { signal })
    }
    if (sandbox.isStrictMode) {
      shellSandboxStrict = true
      console.log("Docker sandbox: STRICT mode (all commands require Docker, relaxed deny list)")
    } else {
      console.log("Docker sandbox: ACTIVE (commands run in isolated containers)")
    }

    const browserReady = await sandbox.ensureBrowserImage()
    if (browserReady) {
      browserCheckMode = "sandbox"
      browserCheckClient = async (htmlPath, clicks, waitMs, cwd) => {
        const script = buildBrowserScript(htmlPath, clicks, waitMs)
        const result = await sandbox.browserExec(script, cwd || getWorkspace(), { timeout: 30_000 })
        if (result.stderr === "FALLBACK_TO_HOST") throw new Error("Browser image not available")
        if (result.exitCode !== 0) {
          return {
            report: `Error: ${result.stderr || result.stdout || "Browser check failed in container"}`,
            sandboxed: true
          }
        }
        try {
          return { report: formatBrowserReport(JSON.parse(result.stdout)), sandboxed: true }
        } catch {
          return { report: result.stdout || "(no output)", sandboxed: true }
        }
      }
      console.log("Browser sandbox: ACTIVE (browser_check runs in isolated containers)")
    } else {
      console.log("Browser sandbox: UNAVAILABLE (browser_check runs on host)")
    }
  } else {
    if (sandbox.isStrictMode) {
      console.error("SANDBOX_MODE=all requires Docker but Docker is not available. Aborting.")
      process.exit(1)
    }
    console.log(
      sandbox.mode === "host"
        ? "Docker sandbox: BYPASSED (commands run on host with filtered env)"
        : "Docker sandbox: UNAVAILABLE (commands run on host with filtered env)"
    )
  }

  return { sandbox, shellClient, shellSandboxStrict, browserCheckMode, browserCheckClient }
}
