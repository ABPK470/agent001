/**
 * Server entry point.
 */
import "./boot/load-env.js"

const args = process.argv.slice(2)

if (args[0] === "setup") {
  const { runSetupCheckOnly } = await import("./cli/setup/gate.js")
  const { runSetupWizard } = await import("./cli/setup/wizard.js")
  const setupArgs = args.slice(1)
  const code =
    setupArgs.includes("--check") || setupArgs.includes("-c")
      ? runSetupCheckOnly()
      : await runSetupWizard({ force: setupArgs.includes("--force") })
  process.exit(code)
}

import { ensureSetupReady } from "./cli/setup/gate.js"
ensureSetupReady()

import { startServer } from "./boot/start-server.js"

startServer().catch((error) => {
  console.error("Failed to start server:", error)
  process.exit(1)
})
