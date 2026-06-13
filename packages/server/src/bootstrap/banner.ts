import { existsSync } from "node:fs"
import { getRunProfile } from "./workspace.js"
import { listenPort } from "./paths.js"

export function printStartupBanner(opts: {
  mssqlSummary: string
  channelConfigs: ReadonlyArray<{ type: string }>
  uiDist: string
}): void {
  const uiExists = existsSync(opts.uiDist)
  console.log(`\n${"═".repeat(50)}`)
  console.log(`  MI:A COMMAND CENTER`)
  console.log(`${"═".repeat(50)}`)
  console.log(`  Server:    http://localhost:${listenPort}`)
  console.log(`  Events:    http://localhost:${listenPort}/api/events/stream  (SSE)`)
  console.log(`  API:       http://localhost:${listenPort}/api`)
  console.log(
    `  Teams:     ${uiExists ? `https://<host>/webhooks/teams` : `http://localhost:${listenPort}/webhooks/teams`}`
  )
  console.log(`  Dashboard: ${uiExists ? `http://localhost:${listenPort}` : "http://localhost:5179 (dev)"}`)
  console.log(
    `  Channels:  ${opts.channelConfigs.length > 0 ? opts.channelConfigs.map((c) => c.type).join(", ") : "none (configure via POST /api/channels)"}`
  )
  console.log(`  MSSQL:     ${opts.mssqlSummary}`)
  const profile = getRunProfile()
  console.log(
    `  Profile:   ${profile === "hosted" ? "HOSTED (sandbox-only, attachments mandatory)" : "developer (legacy local mode)"}`
  )
  console.log(`${"═".repeat(50)}\n`)
}
