#!/usr/bin/env node
/**
 * One-time Copilot auth — runs the GitHub Device Flow and caches the token
 * to ~/.agent001/copilot-token.json so the server never needs to re-auth.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98"
const TOKEN_CACHE_DIR = join(homedir(), ".agent001")
const TOKEN_CACHE_PATH = join(TOKEN_CACHE_DIR, "copilot-token.json")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadCachedToken() {
  try {
    if (!existsSync(TOKEN_CACHE_PATH)) return null
    const raw = readFileSync(TOKEN_CACHE_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    return parsed?.access_token ?? null
  } catch {
    return null
  }
}

function saveCachedToken(token) {
  if (!existsSync(TOKEN_CACHE_DIR)) mkdirSync(TOKEN_CACHE_DIR, { recursive: true })
  writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(token, null, 2), "utf-8")
}

const cached = loadCachedToken()
if (cached) {
  console.log("✓ Token already cached at", TOKEN_CACHE_PATH)
  console.log("  Nothing to do — server will use this automatically.")
  process.exit(0)
}

console.log("\n┌─────────────────────────────────────────────┐")
console.log("│  Copilot Chat — One-time authorization      │")
console.log("└─────────────────────────────────────────────┘\n")

const deviceRes = await fetch("https://github.com/login/device/code", {
  method: "POST",
  headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
  body: `client_id=${COPILOT_CLIENT_ID}&scope=copilot`,
})

if (!deviceRes.ok) {
  console.error("Device Flow initiation failed:", await deviceRes.text())
  process.exit(1)
}

const device = await deviceRes.json()

console.log(`  1. Open:  ${device.verification_uri}`)
console.log(`  2. Enter: ${device.user_code}`)
console.log(`  3. Authorize the GitHub Copilot plugin\n`)
console.log("  Waiting for authorization...")

const interval = Math.max(device.interval, 5) * 1000
const deadline = Date.now() + device.expires_in * 1000

while (Date.now() < deadline) {
  await sleep(interval)

  const pollRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${COPILOT_CLIENT_ID}&device_code=${device.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
  })

  const poll = await pollRes.json()

  if (poll.error === "authorization_pending") continue
  if (poll.error === "slow_down") { await sleep(5000); continue }
  if (poll.error) { console.error("Device Flow failed:", poll.error); process.exit(1) }

  if (poll.access_token) {
    saveCachedToken({ access_token: poll.access_token, token_type: poll.token_type ?? "bearer", scope: poll.scope ?? "copilot" })
    console.log("\n  ✓ Authorized! Token cached to", TOKEN_CACHE_PATH)
    console.log("  You can now start the server — auth is complete.\n")
    process.exit(0)
  }
}

console.error("Device Flow timed out — please run the script again.")
process.exit(1)
