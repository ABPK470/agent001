import { resolve } from "node:path"

const packageRoot = process.env["MIA_PACKAGE_ROOT"]

/** Monorepo root (dev) or install CWD (packaged). */
export const projectRoot = packageRoot ? process.cwd() : resolve(import.meta.dirname, "../../..")

export const listenPort = Number(process.env["PORT"] ?? 3102)
export const listenHost = process.env["HOST"] ?? "0.0.0.0"

export function resolveUiDist(): string {
  return packageRoot
    ? resolve(packageRoot, "dist/ui")
    : resolve(import.meta.dirname, "../../../packages/ui/dist")
}
