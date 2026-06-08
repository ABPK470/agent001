export * from "./backend.js"
export * from "./docker-sandbox.js"
export * from "./helpers.js"
export * from "./types.js"

import { DockerSandbox } from "./docker-sandbox.js"
import type { SandboxConfig } from "./types.js"

// ── Global sandbox singleton ──────────────────────────────────────

let _sandbox: DockerSandbox | null = null

export function getSandbox(): DockerSandbox {
  if (!_sandbox) _sandbox = new DockerSandbox()
  return _sandbox
}

export function initSandbox(config?: SandboxConfig): DockerSandbox {
  _sandbox = new DockerSandbox(config)
  return _sandbox
}
