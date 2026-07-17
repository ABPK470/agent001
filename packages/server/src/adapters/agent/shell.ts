import type { ShellClient } from "@mia/agent"
import { type DockerSandbox, initSandbox } from "../../infra/sandbox/index.js"

export interface SandboxRuntime {
  readonly sandbox: DockerSandbox
  readonly shellClient: ShellClient | null
  readonly shellSandboxStrict: boolean
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

  return { sandbox, shellClient, shellSandboxStrict }
}
