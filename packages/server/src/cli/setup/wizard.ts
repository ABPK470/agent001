import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync } from "node:fs"
import { config } from "dotenv"

import {
  DEFAULT_COPILOT_MODEL,
  DEFAULT_DATABRICKS_MODEL,
} from "../../platform/llm/registry.js"
import {
  databricksAuthMode,
  hasMssqlConfigured,
  promptDefaultForKey,
  readEnvState,
  suggestDataDir,
} from "./env-context.js"
import { applyEnvToProcess, mergeEnvFile } from "./env-file.js"
import {
  formatLlmBootNote,
  formatSetupReport,
  hasBlockingErrors,
  runSetupChecks,
} from "./checks.js"
import { formatSyncBootNote } from "../../bootstrap/published-sync-bundle.js"
import { describeLayout, resolveSetupLayout } from "./layout.js"
import type { SetupLayout } from "./types.js"

type Updates = Record<string, string | undefined>

async function ask(
  rl: ReturnType<typeof createInterface>,
  label: string,
  current?: string,
  fallback?: string,
): Promise<string | undefined> {
  const shown = promptDefaultForKey(label, current) ?? fallback
  const suffix = shown ? ` [${shown}]` : ""
  const answer = (await rl.question(`${label}${suffix}: `)).trim()
  if (!answer) {
    if (current) return undefined
    return fallback
  }
  if (answer === "(already set — Enter to keep)" && current) return undefined
  return answer
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N"
  const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase()
  if (!answer) return defaultYes
  return answer.startsWith("y")
}

function ensureEnvFile(layout: SetupLayout): void {
  if (existsSync(layout.envPath)) return
  if (existsSync(layout.envExamplePath)) {
    copyFileSync(layout.envExamplePath, layout.envPath)
    console.log(`Created ${layout.envPath} from .env.example`)
  }
}

function reloadEnv(layout: SetupLayout): void {
  config({ path: layout.envPath, override: true })
}

async function collectCore(
  rl: ReturnType<typeof createInterface>,
  layout: SetupLayout,
  env: ReturnType<typeof readEnvState>,
): Promise<Updates> {
  const updates: Updates = {}

  const dataDir = await ask(rl, "MIA_DATA_DIR", env.get("MIA_DATA_DIR"), suggestDataDir(layout.packaged))
  if (dataDir) updates.MIA_DATA_DIR = dataDir

  const isProd =
    layout.isProduction ||
    layout.packaged ||
    (await askYesNo(rl, "Production (NODE_ENV=production)?", layout.isProduction))
  if (isProd) {
    updates.NODE_ENV = "production"
    const secret =
      (await ask(
        rl,
        "MIA_COOKIE_SECRET",
        env.get("MIA_COOKIE_SECRET"),
        randomBytes(32).toString("hex"),
      )) ?? (env.get("MIA_COOKIE_SECRET") ? undefined : randomBytes(32).toString("hex"))
    if (secret) updates.MIA_COOKIE_SECRET = secret
  }

  const port = await ask(rl, "PORT", env.get("PORT"), "3102")
  if (port) updates.PORT = port

  const host = await ask(rl, "HOST", env.get("HOST"), "0.0.0.0")
  if (host) updates.HOST = host

  return updates
}

async function collectLlm(
  rl: ReturnType<typeof createInterface>,
  env: ReturnType<typeof readEnvState>,
): Promise<Updates> {
  const updates: Updates = {}
  const current = env.get("LLM_PROVIDER")
  const provider = await ask(rl, "LLM_PROVIDER (copilot-chat | databricks)", current, current ?? "copilot-chat")
  const resolved = (provider ?? current ?? "copilot-chat") === "databricks" ? "databricks" : "copilot-chat"
  if (!current || resolved !== current) updates.LLM_PROVIDER = resolved

  const modelDefault = resolved === "databricks" ? DEFAULT_DATABRICKS_MODEL : DEFAULT_COPILOT_MODEL
  const modelLabel =
    resolved === "databricks"
      ? "LLM_MODEL (Databricks serving endpoint name)"
      : "LLM_MODEL (Copilot model id)"
  const model = await ask(rl, modelLabel, env.get("LLM_MODEL"), modelDefault)
  if (model) updates.LLM_MODEL = model

  if (resolved !== "databricks") return updates

  const host = await ask(rl, "DATABRICKS_HOST", env.get("DATABRICKS_HOST"))
  if (host) updates.DATABRICKS_HOST = host

  const mode = databricksAuthMode(env) ?? "m2m"
  const useM2m =
    env.get("DATABRICKS_CLIENT_ID") && env.get("DATABRICKS_CLIENT_SECRET")
      ? mode === "m2m"
      : env.get("DATABRICKS_TOKEN")
        ? false
        : await askYesNo(rl, "Databricks M2M client credentials (not PAT)?", true)

  if (useM2m) {
    const clientId = await ask(rl, "DATABRICKS_CLIENT_ID", env.get("DATABRICKS_CLIENT_ID"))
    if (clientId) updates.DATABRICKS_CLIENT_ID = clientId
    const clientSecret = await ask(rl, "DATABRICKS_CLIENT_SECRET", env.get("DATABRICKS_CLIENT_SECRET"))
    if (clientSecret) updates.DATABRICKS_CLIENT_SECRET = clientSecret
  } else {
    const token = await ask(rl, "DATABRICKS_TOKEN", env.get("DATABRICKS_TOKEN"))
    if (token) updates.DATABRICKS_TOKEN = token
  }

  return updates
}

async function collectMssqlIfNeeded(
  rl: ReturnType<typeof createInterface>,
  env: ReturnType<typeof readEnvState>,
  force: boolean,
): Promise<Updates> {
  if (hasMssqlConfigured(env) && !force) {
    console.log("MSSQL: using existing .env values (Enter skipped prompts).")
    return {}
  }

  const configure = force
    ? await askYesNo(rl, "Configure MSSQL in .env?", hasMssqlConfigured(env))
    : await askYesNo(rl, "Add MSSQL to .env now?", false)
  if (!configure) return {}

  const updates: Updates = {}
  const host = await ask(rl, "MSSQL_HOST", env.get("MSSQL_HOST"))
  if (host) updates.MSSQL_HOST = host
  const port = await ask(rl, "MSSQL_PORT", env.get("MSSQL_PORT"), "1433")
  if (port) updates.MSSQL_PORT = port
  const database = await ask(rl, "MSSQL_DATABASE", env.get("MSSQL_DATABASE"))
  if (database) updates.MSSQL_DATABASE = database
  const domain = await ask(rl, "MSSQL_DOMAIN", env.get("MSSQL_DOMAIN"))
  if (domain) updates.MSSQL_DOMAIN = domain
  const knowledge = await ask(
    rl,
    "MSSQL_KNOWLEDGE_FILE",
    env.get("MSSQL_KNOWLEDGE_FILE"),
    "./deploy/mssql/mymi-knowledge.md",
  )
  if (knowledge) updates.MSSQL_KNOWLEDGE_FILE = knowledge
  return updates
}

async function promptForBlockingGaps(
  rl: ReturnType<typeof createInterface>,
  layout: SetupLayout,
  report: ReturnType<typeof runSetupChecks>,
): Promise<Updates> {
  const env = readEnvState(layout.envPath)
  const failed = new Set(report.checks.filter((c) => c.severity === "error").map((c) => c.id))
  const updates: Updates = {}

  if (failed.has("env-file")) ensureEnvFile(layout)

  if (failed.has("mia-data-dir") || failed.has("mia-data-dir-writable")) {
    const dataDir = await ask(rl, "MIA_DATA_DIR", env.get("MIA_DATA_DIR"), suggestDataDir(layout.packaged))
    if (dataDir) updates.MIA_DATA_DIR = dataDir
  }

  if (failed.has("cookie-secret")) {
    const secret =
      (await ask(rl, "MIA_COOKIE_SECRET", env.get("MIA_COOKIE_SECRET"), randomBytes(32).toString("hex"))) ??
      randomBytes(32).toString("hex")
    updates.MIA_COOKIE_SECRET = secret
    updates.NODE_ENV = "production"
  }

  if (failed.has("llm-provider") || failed.has("llm-databricks")) {
    Object.assign(updates, await collectLlm(rl, env))
  }

  if (failed.has("agent-workspace")) {
    const workspace = await ask(rl, "AGENT_WORKSPACE", env.get("AGENT_WORKSPACE"), layout.projectRoot)
    if (workspace) updates.AGENT_WORKSPACE = workspace
  }

  if (failed.has("port")) {
    const port = await ask(rl, "PORT", env.get("PORT"), "3102")
    if (port) updates.PORT = port
  }

  return updates
}

export async function runSetupWizard(opts?: { force?: boolean }): Promise<number> {
  const layout = resolveSetupLayout()
  ensureEnvFile(layout)
  reloadEnv(layout)

  let report = runSetupChecks(layout)

  console.log("")
  console.log("MI:A setup")
  console.log(`Mode: ${describeLayout(layout)}`)
  console.log(`Env:  ${layout.envPath}`)
  console.log("")

  if (!opts?.force && !hasBlockingErrors(report)) {
    console.log(formatSetupReport(report))
    console.log("")
    console.log(formatLlmBootNote())
    if (hasMssqlConfigured(readEnvState(layout.envPath))) {
      console.log("")
      console.log(formatSyncBootNote())
    }
    console.log("")
    console.log("Setup complete — nothing to change. Start with npm run dev or npm start.")
    console.log("Re-run with --force to walk through all prompts.")
    return 0
  }

  if (!process.stdin.isTTY) {
    console.error(formatSetupReport(report))
    console.error("")
    console.error("Fix .env manually or run setup in an interactive terminal.")
    return 1
  }

  const rl = createInterface({ input, output })
  let updates: Updates = {}

  try {
    if (opts?.force) {
      console.log("Reconfigure (--force) — existing .env values are defaults; Enter keeps them.")
      console.log("")
      const env = readEnvState(layout.envPath)
      updates = {
        ...(await collectCore(rl, layout, env)),
        ...(await collectLlm(rl, env)),
        ...(await collectMssqlIfNeeded(rl, env, true)),
      }
      if (!layout.packaged) {
        const workspace = await ask(rl, "AGENT_WORKSPACE", env.get("AGENT_WORKSPACE"), layout.projectRoot)
        if (workspace) updates.AGENT_WORKSPACE = workspace
        const sandbox = await ask(rl, "SANDBOX_MODE", env.get("SANDBOX_MODE"), "host")
        if (sandbox) updates.SANDBOX_MODE = sandbox
      }
    } else {
      console.log(formatSetupReport(report))
      console.log("")
      console.log("Answer only what is missing — existing .env values are kept when you press Enter.")
      console.log("")
      updates = await promptForBlockingGaps(rl, layout, report)
    }
  } finally {
    rl.close()
  }

  mergeEnvFile(layout.envPath, updates, { examplePath: layout.envExamplePath })
  if (Object.keys(updates).some((k) => updates[k] !== undefined)) {
    console.log("")
    console.log(`Updated ${layout.envPath}`)
  }

  reloadEnv(layout)
  applyEnvToProcess(updates)

  report = runSetupChecks(layout)
  console.log("")
  console.log(formatSetupReport(report))
  console.log("")
  console.log(formatLlmBootNote())
  if (hasMssqlConfigured(readEnvState(layout.envPath))) {
    console.log("")
    console.log(formatSyncBootNote())
  }
  console.log("")

  if (hasBlockingErrors(report)) {
    console.log("Setup incomplete — fix remaining issues in .env or run npm run setup again.")
    return 1
  }

  console.log("Setup complete. Start with npm run dev (monorepo) or npm start (release).")
  return 0
}
