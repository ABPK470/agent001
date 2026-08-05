#!/usr/bin/env node
/**
 * Assemble a deployable release folder (no monorepo source required at runtime).
 *
 * Output: release/
 *   dist/server.js       — bundled server (esbuild; native: better-sqlite3 only)
 *   dist/ui/             — Vite production dashboard
 *   dist/prompts/        — agent prompts
 *   deploy/              — sync seeds, policies, connectors, tenant config
 *   sync-definitions/    — optional legacy published bundle (imported once on upgrade)
 *   .env.example
 *   package.json         — runtime native deps + postinstall
 *   start.mjs            — sets MIA_PACKAGE_ROOT, loads .env, starts server
 *   scripts/ensure-native-modules.mjs
 *
 * Usage:
 *   npm run package
 *   cd release && npm install && cp .env.example .env && npm run setup && npm start
 */

import { execSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const release = resolve(root, "release")

const REQUIRED_PATHS = [
  "dist/server.js",
  "dist/ui/index.html",
  "dist/prompts",
  "deploy/policies/defaults.json",
  "deploy/sync/artifacts",
  ".env.example",
]

const OPTIONAL_PATHS = ["sync-definitions"]

const JUNK_FILENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"])
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const WINDOWS_ILLEGAL = /[<>:"|?*\\]/

/** Drop dev artifacts and validate paths before copying release/ to Windows hosts. */
function sanitizeReleaseTree(dir, rel = "") {
  if (!existsSync(dir)) return { removed: 0, issues: [] }

  let removed = 0
  const issues = []

  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name)
    const relPath = rel ? `${rel}/${name}` : name
    const stat = lstatSync(path)

    if (stat.isSymbolicLink()) {
      issues.push(`${relPath}: symlinks are not portable — use regular files only`)
      continue
    }

    if (stat.isDirectory()) {
      const nested = sanitizeReleaseTree(path, relPath)
      removed += nested.removed
      issues.push(...nested.issues)
      continue
    }

    if (JUNK_FILENAMES.has(name) || name.startsWith("._") || name.endsWith(".map")) {
      rmSync(path)
      removed += 1
      continue
    }

    const segmentIssue = windowsPathSegmentIssue(name)
    if (segmentIssue) issues.push(`${relPath}: ${segmentIssue}`)
  }

  return { removed, issues }
}

function windowsPathSegmentIssue(name) {
  if (WINDOWS_ILLEGAL.test(name)) {
    return "filename contains characters Windows does not allow (< > : \" | ? * \\)"
  }
  if (/[. ]$/.test(name)) {
    return "filename must not end with a space or dot on Windows"
  }
  const stem = name.includes(".") ? name.slice(0, name.indexOf(".")) : name
  if (WINDOWS_RESERVED.test(stem)) {
    return `filename "${name}" is reserved on Windows`
  }
  return null
}

function stripSourceMappingComment(serverJsPath) {
  if (!existsSync(serverJsPath)) return false
  const text = readFileSync(serverJsPath, "utf8")
  const next = text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/u, "")
  if (next === text) return false
  writeFileSync(serverJsPath, next)
  return true
}

console.log("Running production build…")
execSync("node scripts/build.mjs", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, MIA_RELEASE_BUILD: "1" },
})

rmSync(release, { recursive: true, force: true })
mkdirSync(release, { recursive: true })

for (const dir of ["dist", "deploy"]) {
  cpSync(resolve(root, dir), resolve(release, dir), { recursive: true })
}

for (const dir of OPTIONAL_PATHS) {
  const src = resolve(root, dir)
  if (existsSync(src)) {
    cpSync(src, resolve(release, dir), { recursive: true })
    console.log(`  included optional ${dir}/`)
  } else {
    console.log(`  skipped optional ${dir}/ (not present — Publish writes SQLite instead)`)
  }
}

cpSync(resolve(root, ".env.example"), resolve(release, ".env.example"))

mkdirSync(resolve(release, "scripts"), { recursive: true })
cpSync(
  resolve(root, "scripts/ensure-native-modules.mjs"),
  resolve(release, "scripts/ensure-native-modules.mjs"),
)

writeFileSync(
  resolve(release, "package.json"),
  `${JSON.stringify(
    {
      name: "mia-release",
      private: true,
      type: "module",
      scripts: {
        start: "node start.mjs",
        setup: "node start.mjs setup",
        "setup:check": "node start.mjs setup -- --check",
        postinstall: "node scripts/ensure-native-modules.mjs",
      },
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

const strippedMapComment = stripSourceMappingComment(resolve(release, "dist/server.js"))
const { removed: sanitizedCount, issues: pathIssues } = sanitizeReleaseTree(release)
if (sanitizedCount > 0) {
  console.log(`  sanitized release/ (${sanitizedCount} dev-only or junk file(s) removed)`)
}
if (strippedMapComment) {
  console.log("  stripped //# sourceMappingURL from dist/server.js")
}
if (pathIssues.length > 0) {
  console.error("")
  console.error("Release assembly failed — paths not safe for Windows deploy:")
  for (const issue of pathIssues) console.error(`  ✗ ${issue}`)
  process.exit(1)
}

const missing = REQUIRED_PATHS.filter((rel) => !existsSync(resolve(release, rel)))
if (missing.length > 0) {
  console.error("")
  console.error("Release assembly failed — missing required paths:")
  for (const rel of missing) console.error(`  ✗ ${rel}`)
  process.exit(1)
}

console.log("")
console.log("Release ready → release/")
console.log("  cd release")
console.log("  npm install              # rebuilds better-sqlite3 for this host")
console.log("  cp .env.example .env")
console.log("  npm run setup              # first-time wizard (data dir, LLM, secrets)")
console.log("  npm run setup:check        # validate .env anytime")
console.log("  npm start                  # http://localhost:3102 (PORT in .env)")
