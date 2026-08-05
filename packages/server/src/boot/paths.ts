import { existsSync } from "node:fs"
import { resolve } from "node:path"

const packaged = Boolean(process.env["MIA_PACKAGE_ROOT"])

function findRepoRoot(from: string): string {
  let dir = resolve(from)
  while (dir !== resolve(dir, "..")) {
    if (existsSync(resolve(dir, ".git"))) return dir
    dir = resolve(dir, "..")
  }
  return from
}

/** Monorepo root (dev) or install CWD (packaged). */
export const projectRoot = packaged ? process.cwd() : findRepoRoot(resolve(import.meta.dirname, "../.."))

export const listenPort = Number(process.env["PORT"] ?? 3102)
export const listenHost = process.env["HOST"] ?? "0.0.0.0"

export function resolveUiDist(): string {
  return packaged
    ? resolve(projectRoot, "dist/ui")
    : resolve(projectRoot, "packages/ui/dist")
}
