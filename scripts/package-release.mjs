#!/usr/bin/env node
/**
 * Assemble a deployable release folder (no monorepo source required at runtime).
 *
 * Output: release/
 *   dist/server.js       — bundled server (run with node)
 *   dist/ui/             — dashboard static files
 *   dist/prompts/        — agent prompts
 *   deploy/              — sync seeds, generators, MSSQL knowledge
 *   sync-definitions/    — published bundle + paths
 *   .env.example
 *   package.json         — runtime native deps only
 *   start.mjs            — sets MIA_PACKAGE_ROOT and starts server
 *
 * Usage:
 *   npm run package
 *   cd release && npm install && cp .env.example .env && npm start
 */

import { execSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const release = resolve(root, "release")

console.log("Running production build…")
execSync("node scripts/build.mjs", { cwd: root, stdio: "inherit" })

rmSync(release, { recursive: true, force: true })
mkdirSync(release, { recursive: true })

for (const dir of ["dist", "deploy", "sync-definitions"]) {
  cpSync(resolve(root, dir), resolve(release, dir), { recursive: true })
}
cpSync(resolve(root, ".env.example"), resolve(release, ".env.example"))

writeFileSync(
  resolve(release, "package.json"),
  `${JSON.stringify(
    {
      name: "mia-release",
      private: true,
      type: "module",
      scripts: { start: "node start.mjs", setup: "node start.mjs setup" },
      dependencies: {
        "better-sqlite3": "^12.10.0",
        dotenv: "^17.3.1",
        mssql: "^12.2.1",
      },
      engines: { node: ">=20" },
    },
    null,
    2,
  )}\n`,
)

writeFileSync(
  resolve(release, "start.mjs"),
  `#!/usr/bin/env node
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
process.env.MIA_PACKAGE_ROOT = process.env.MIA_PACKAGE_ROOT ?? "1"
process.chdir(here)

const envPath = resolve(here, ".env")
if (existsSync(envPath)) {
  const { config } = await import("dotenv")
  config({ path: envPath })
}

await import("./dist/server.js")
`,
)

console.log("")
console.log("Release ready → release/")
console.log("  cd release")
console.log("  npm install")
console.log("  cp .env.example .env   # then: npm run setup  (or npm start after editing .env)")
console.log("  npm run setup            # interactive first-time configuration")
console.log("  npm start                # http://localhost:3102")
