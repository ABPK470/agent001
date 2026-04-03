/**
 * Build script — bundles agent001 into a self-contained npm package.
 *
 * Output structure in dist/:
 *   dist/server.js    — esbuild bundle of server + agent (single file)
 *   dist/ui/          — Vite-built frontend (static files)
 *   bin/agent001.js   — CLI entry point (thin wrapper)
 *
 * Native/binary modules are kept external (installed via npm at the target):
 *   better-sqlite3, mssql, puppeteer, dotenv
 */

import * as esbuild from "esbuild"
import { execSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const DIST = resolve(ROOT, "dist")

function run(cmd, cwd = ROOT) {
    console.log(`  $ ${cmd}`)
    execSync(cmd, { cwd, stdio: "inherit" })
}

async function main() {
    console.log("\n🔨 Building agent001 package...\n")

    // ── Clean ────────────────────────────────────────────────
    if (existsSync(DIST)) rmSync(DIST, { recursive: true })
    mkdirSync(DIST, { recursive: true })

    // ── 1. Bundle server + agent with esbuild ────────────────
    console.log("1/3  Bundling server + agent → dist/server.js")

    await esbuild.build({
        entryPoints: [resolve(ROOT, "packages/server/src/index.ts")],
        bundle: true,
        platform: "node",
        target: "node20",
        format: "esm",
        outfile: resolve(DIST, "server.js"),
        // Keep ALL npm packages external — they'll be npm-installed at the target.
        // We only inline the workspace TypeScript (server + agent source code).
        packages: "external",
        // Resolve workspace package @agent001/agent as part of the bundle
        alias: {
            "@agent001/agent": resolve(ROOT, "packages/agent/src/lib.ts"),
        },
        sourcemap: true,
        minify: false,         // Keep readable for debugging
        banner: {
            // import.meta.dirname polyfill for the bundled file
            js: `import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __dirname_ } from 'node:path'; const __bundleDir = __dirname_(__fileURLToPath(import.meta.url));`,
        },
        define: {
            // Replace import.meta.dirname references with the bundle dir
            "import.meta.dirname": "__bundleDir",
        },
        logLevel: "warning",
    })

    console.log("   ✓ dist/server.js")

    // ── 2. Build UI with Vite ────────────────────────────────
    console.log("2/3  Building UI → dist/ui/")
    run("npx vite build --outDir ../../dist/ui", resolve(ROOT, "packages/ui"))
    console.log("   ✓ dist/ui/")

    // ── 3. Copy static assets ────────────────────────────────
    console.log("3/3  Copying assets")

    // Copy the seed SQL for MSSQL setup
    if (existsSync(resolve(ROOT, "deploy/mssql"))) {
        mkdirSync(resolve(DIST, "deploy/mssql"), { recursive: true })
        cpSync(resolve(ROOT, "deploy/mssql"), resolve(DIST, "deploy/mssql"), { recursive: true })
        console.log("   ✓ dist/deploy/mssql/")
    }

    console.log("\n✅ Build complete → dist/\n")
}

main().catch((err) => {
    console.error("Build failed:", err)
    process.exit(1)
})
