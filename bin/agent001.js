#!/usr/bin/env node

/**
 * agent001 CLI — starts the Agent001 Command Center.
 *
 * Usage:
 *   agent001                     Start with default settings
 *   agent001 --port 8080         Custom port (default: 3001)
 *   agent001 --host 127.0.0.1   Bind to specific host (default: 0.0.0.0)
 *   agent001 --help              Show help
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Package root — one level up from bin/
const pkgRoot = resolve(__dirname, "..")

// Tell the server it's running as an installed package
process.env["AGENT001_PACKAGE_ROOT"] = pkgRoot

// Parse CLI flags
const args = process.argv.slice(2)

function getFlag(name) {
    const idx = args.indexOf(`--${name}`)
    if (idx === -1) return undefined
    return args[idx + 1]
}

if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  agent001 — AI Agent Command Center

  Usage:
    agent001 [options]

  Options:
    --port <number>    Server port (default: 3001, or PORT env var)
    --host <string>    Bind address (default: 0.0.0.0, or HOST env var)
    --workspace <path> Agent workspace directory (default: current directory)
    --help, -h         Show this help message

  Environment variables:
    PORT               Server port
    HOST               Bind address
    AGENT_WORKSPACE    Agent workspace directory
    AGENT001_DATA_DIR  Data directory for SQLite DB (default: ~/.agent001)
    GITHUB_TOKEN       GitHub token for LLM API access
    MSSQL_HOST         MSSQL server host (enables MSSQL tools)
    MSSQL_USER         MSSQL username
    MSSQL_PASSWORD     MSSQL password
    MSSQL_DATABASE     MSSQL database name

  The server will look for a .env file in the current directory.
`)
    process.exit(0)
}

// Forward CLI flags to env vars (CLI takes precedence over env)
const port = getFlag("port")
if (port) process.env["PORT"] = port

const host = getFlag("host")
if (host) process.env["HOST"] = host

const workspace = getFlag("workspace")
if (workspace) process.env["AGENT_WORKSPACE"] = resolve(workspace)

// Import and run the bundled server
await import("../dist/server.js")
