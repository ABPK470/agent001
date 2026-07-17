/**
 * MI:A setup — validate `.env` or fill gaps interactively.
 *
 *   npm run setup              validate; prompt only if something is missing
 *   npm run setup -- --check   validate only (no prompts)
 *   npm run setup -- --force   walk through all prompts (defaults from .env)
 */

import "../boot/load-env.js"

import { runSetupCheckOnly } from "./setup/gate.js"
import { runSetupWizard } from "./setup/wizard.js"

const args = process.argv.slice(2)

async function main(): Promise<number> {
  if (args.includes("--check") || args.includes("-c")) {
    return runSetupCheckOnly()
  }
  return runSetupWizard({ force: args.includes("--force") })
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
