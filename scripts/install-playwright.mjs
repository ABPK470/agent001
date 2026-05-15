#!/usr/bin/env node
/**
 * Postinstall hook: ensure Playwright's Chromium binary is downloaded.
 *
 * Why this exists:
 *   The agent's `web_search` / `browse_web` tools both depend on Playwright.
 *   On a fresh checkout the binary is NOT bundled with the npm package — it
 *   has to be fetched from cdn.playwright.dev. If the agent tries to install
 *   it on demand at runtime it hits two problems:
 *     1. The agent's `run_command` tool times out before a 169 MB download
 *        completes on a corp WAN.
 *     2. Corp TLS interception (Netskope/Zscaler) breaks the download unless
 *        NODE_EXTRA_CA_CERTS is set.
 *   So we do it ONCE here, at install time, where the user already has full
 *   shell access and the corp CA bundle is already on PATH.
 *
 * Behaviour:
 *   - Skips entirely if MIA_SKIP_PLAYWRIGHT_INSTALL=1 (CI / Docker images
 *     that ship a pre-baked browser).
 *   - Skips if Playwright's local cache already has a chromium build.
 *   - Otherwise runs `npx playwright install chromium`, inheriting the
 *     parent env (so a user-set NODE_EXTRA_CA_CERTS flows through).
 *   - Failure is logged but does NOT fail `npm install` — the agent still
 *     boots without web tools rather than blocking unrelated workflows.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"

if (process.env["MIA_SKIP_PLAYWRIGHT_INSTALL"] === "1") {
  console.log("[mia] MIA_SKIP_PLAYWRIGHT_INSTALL=1 — skipping Playwright Chromium install.")
  process.exit(0)
}

const cacheRoot = (() => {
  if (process.env["PLAYWRIGHT_BROWSERS_PATH"]) return process.env["PLAYWRIGHT_BROWSERS_PATH"]
  switch (platform()) {
    case "darwin": return join(homedir(), "Library", "Caches", "ms-playwright")
    case "win32":  return join(process.env["LOCALAPPDATA"] ?? homedir(), "ms-playwright")
    default:       return join(homedir(), ".cache", "ms-playwright")
  }
})()

function chromiumAlreadyInstalled() {
  if (!existsSync(cacheRoot)) return false
  try {
    const entries = readdirSync(cacheRoot)
    // Playwright lays down folders like `chromium-1234`, `chromium_headless_shell-1223`, etc.
    // We only need *something* chromium-shaped that the launcher can find.
    return entries.some((e) => /^chromium/.test(e) && statSync(join(cacheRoot, e)).isDirectory())
  } catch { return false }
}

if (chromiumAlreadyInstalled()) {
  console.log(`[mia] Playwright Chromium already present in ${cacheRoot} — skipping download.`)
  process.exit(0)
}

console.log("[mia] Installing Playwright Chromium (one-time, ~170 MB)…")
if (process.env["NODE_EXTRA_CA_CERTS"]) {
  console.log(`[mia]   using NODE_EXTRA_CA_CERTS=${process.env["NODE_EXTRA_CA_CERTS"]}`)
}

const result = spawnSync("npx", ["--yes", "playwright", "install", "chromium"], {
  stdio: "inherit",
  env:   process.env,
  shell: platform() === "win32",
})

if (result.status === 0) {
  console.log("[mia] Playwright Chromium installed.")
  process.exit(0)
}

console.warn("")
console.warn("[mia] ⚠ Playwright Chromium install failed.")
console.warn("[mia]   The server will still boot, but web_search / browse_web tools will be unavailable.")
console.warn("[mia]   Most common cause: corp TLS interception. Fix:")
console.warn("[mia]     export NODE_EXTRA_CA_CERTS=$HOME/.mia/certs/corp-bundle.pem")
console.warn("[mia]     npx playwright install chromium")
console.warn("[mia]   To suppress this hook entirely: MIA_SKIP_PLAYWRIGHT_INSTALL=1 npm install")
console.warn("")
// Exit 0 so npm install succeeds. The runtime can detect and surface a clear error.
process.exit(0)
