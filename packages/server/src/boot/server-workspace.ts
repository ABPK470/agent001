import { existsSync } from "node:fs"
import { resolve } from "node:path"

function findRepoRoot(from: string): string {
  let dir = resolve(from)
  while (dir !== resolve(dir, "..")) {
    if (existsSync(resolve(dir, ".git"))) return dir
    dir = resolve(dir, "..")
  }
  return from
}

/** Resolve the server-level agent workspace directory (AGENT_WORKSPACE or repo root). */
export function resolveServerWorkspace(): string {
  const workspace = resolve(process.env["AGENT_WORKSPACE"] ?? findRepoRoot(process.cwd()))
  console.log(`Agent workspace: ${workspace}`)
  return workspace
}

export interface ServerWorkspaceRef {
  readonly get: () => string
  readonly set: (path: string) => void
}

export function createServerWorkspaceRef(
  initial: string,
  onSet?: (path: string) => void
): ServerWorkspaceRef {
  let current = initial
  return {
    get: () => current,
    set: (path) => {
      current = path
      onSet?.(path)
    }
  }
}
