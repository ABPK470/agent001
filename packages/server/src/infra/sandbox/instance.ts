import { DockerSandbox } from "./docker-sandbox.js"
import type { SandboxConfig } from "./types.js"

const sandboxState: { current: DockerSandbox | null } = { current: null }

export function getSandbox(): DockerSandbox {
  if (!sandboxState.current) sandboxState.current = new DockerSandbox()
  return sandboxState.current
}

export function initSandbox(config?: SandboxConfig): DockerSandbox {
  sandboxState.current = new DockerSandbox(config)
  return sandboxState.current
}
