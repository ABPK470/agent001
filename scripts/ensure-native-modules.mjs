#!/usr/bin/env node
/**
 * Verify better-sqlite3 native bindings load for this Node binary.
 * Runs on postinstall and predev — rebuilds automatically when bindings
 * are missing or were compiled for a different Node version.
 */

import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { platform } from "node:os"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

function log(msg) {
  console.log(`[mia] ${msg}`)
}

function logError(msg) {
  console.error(`[mia] ${msg}`)
}

function resolveBetterSqlite3Root() {
  try {
    return dirname(require.resolve("better-sqlite3/package.json"))
  } catch {
    return null
  }
}

function tryLoad() {
  try {
    require("better-sqlite3")
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err }
  }
}

function macOsBuildHint() {
  if (platform() !== "darwin") return
  const xcode = spawnSync("xcode-select", ["-p"], { encoding: "utf8" })
  if (xcode.status !== 0) {
    logError("macOS: Xcode Command Line Tools are required to compile better-sqlite3.")
    logError("  Run: xcode-select --install")
  }
}

function rebuild() {
  log(`rebuilding better-sqlite3 for Node ${process.version} (modules ABI ${process.versions.modules})…`)
  const result = spawnSync("npm", ["rebuild", "better-sqlite3", "--build-from-source"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    shell: platform() === "win32"
  })
  return result.status === 0
}

function printFailure(loadError) {
  const pkgRoot = resolveBetterSqlite3Root()
  const releaseDir = pkgRoot ? join(pkgRoot, "build", "Release") : null
  const hasBinary = releaseDir ? existsSync(join(releaseDir, "better_sqlite3.node")) : false

  console.error("")
  logError("✗ better-sqlite3 native bindings are missing or incompatible.")
  logError(`  Node: ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})`)
  if (pkgRoot) logError(`  Package: ${pkgRoot}`)
  if (releaseDir) {
    logError(
      `  Expected binary: ${join(releaseDir, "better_sqlite3.node")} (${hasBinary ? "exists but won't load" : "missing"})`
    )
  }
  if (loadError) logError(`  Load error: ${loadError.message ?? loadError}`)
  console.error("")
  logError("Usually: stale node_modules after git pull, or bindings built for a different Node version.")
  logError("Corporate npm registry? If GitHub prebuilds are blocked, compile locally:")
  logError("  export npm_config_build_from_source=true")
  logError("  xcode-select --install   # macOS")
  logError("Fix (from repo root):")
  logError("  rm -rf node_modules")
  logError("  npm install")
  logError("  npm run rebuild:native")
  console.error("")
  macOsBuildHint()
  console.error("")
}

const first = tryLoad()
if (first.ok) {
  log(`better-sqlite3 OK (Node ${process.version})`)
  process.exit(0)
}

if (!rebuild()) {
  printFailure(first.error)
  process.exit(1)
}

const second = tryLoad()
if (second.ok) {
  log("better-sqlite3 rebuilt successfully.")
  process.exit(0)
}

printFailure(second.error)
process.exit(1)
