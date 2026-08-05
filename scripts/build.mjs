#!/usr/bin/env node
/**
 * Production build — single bundled server + static UI.
 *
 * Output:
 *   dist/server.js      — esbuild bundle (entry: packages/server/src/index.ts)
 *   dist/prompts/       — agent prompt assets
 *   dist/ui/            — Vite production build of packages/ui
 */

import * as esbuild from "esbuild"
import { execSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(root, "dist")
const releaseBuild = process.env.MIA_RELEASE_BUILD === "1"

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

console.log("Building UI…")
execSync("npm run build -w packages/ui", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, MIA_RELEASE_BUILD: releaseBuild ? "1" : process.env.MIA_RELEASE_BUILD },
})

console.log("Bundling server…")
await esbuild.build({
  absWorkingDir: root,
  entryPoints: [resolve(root, "packages/server/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(dist, "server.js"),
  // Release deploys skip source maps — large, embed dev paths, and break some Windows copy tools.
  sourcemap: releaseBuild ? false : true,
  logLevel: "info",
  external: [
    "better-sqlite3",
    "tiktoken",
  ],
})

cpSync(resolve(root, "packages/ui/dist"), resolve(dist, "ui"), { recursive: true })
cpSync(resolve(root, "packages/agent/prompts"), resolve(dist, "prompts"), { recursive: true })

console.log("Build complete → dist/")
