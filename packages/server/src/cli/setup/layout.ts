import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { projectRoot } from "../../boot/paths.js"

import type { SetupLayout } from "./types.js"

export function resolveSetupLayout(): SetupLayout {
  const root = projectRoot
  const packaged = Boolean(process.env.MIA_PACKAGE_ROOT)
  const isProduction = process.env.NODE_ENV === "production"
  return {
    projectRoot: root,
    envPath: resolve(root, ".env"),
    envExamplePath: resolve(root, ".env.example"),
    packaged,
    isProduction,
  }
}

export function describeLayout(layout: SetupLayout): string {
  if (layout.packaged) return "packaged release"
  if (existsSync(resolve(layout.projectRoot, ".git"))) return "monorepo development"
  return "local checkout"
}
