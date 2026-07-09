import { accessSync, constants, existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

import { isPublishedSyncBundlePresent, PUBLISHED_SYNC_BUNDLE_PATH } from "../../bootstrap/published-sync-bundle.js"
import { resolveUiDist } from "../../bootstrap/paths.js"
import { isDatabricksConfigured } from "../../platform/llm/databricks-broker.js"
import { resolveServerDataDir } from "../../platform/persistence/server-data-dir.js"
import { isLlmProvider } from "../../shared/enums/llm.js"

import { databricksAuthMode, hasMssqlConfigured, readEnvState, suggestDataDir } from "./env-context.js"
import type { SetupCheck, SetupLayout, SetupReport } from "./types.js"

function ok(id: string, label: string, message: string): SetupCheck {
  return { id, label, severity: "ok", message }
}

function warn(id: string, label: string, message: string, hint?: string): SetupCheck {
  return { id, label, severity: "warn", message, hint }
}

function error(id: string, label: string, message: string, hint?: string): SetupCheck {
  return { id, label, severity: "error", message, hint }
}

function isWritableDir(path: string, create = false): boolean {
  try {
    if (!existsSync(path)) {
      if (!create) return false
      mkdirSync(path, { recursive: true })
    }
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function runSetupChecks(layout: SetupLayout): SetupReport {
  const checks: SetupCheck[] = []
  const env = readEnvState(layout.envPath)

  const nodeMajor = Number(process.versions.node.split(".")[0])
  checks.push(
    nodeMajor >= 20
      ? ok("node", "Node.js", `v${process.versions.node}`)
      : error("node", "Node.js", `v${process.versions.node} — Node 20+ required`, "Install Node.js 20 LTS or newer."),
  )

  if (!existsSync(layout.envPath)) {
    checks.push(
      error(
        "env-file",
        ".env file",
        `Missing ${layout.envPath}`,
        "Run: npm run setup",
      ),
    )
  } else {
    checks.push(ok("env-file", ".env file", layout.envPath))
  }

  const dataDir = env.get("MIA_DATA_DIR")
  if (!dataDir) {
    checks.push(
      error(
        "mia-data-dir",
        "Data directory",
        "MIA_DATA_DIR is not set in .env",
        `Run npm run setup or set MIA_DATA_DIR (e.g. ${suggestDataDir(layout)})`,
      ),
    )
  } else {
    checks.push(ok("mia-data-dir", "Data directory", dataDir))
    checks.push(
      isWritableDir(resolveServerDataDir(), true)
        ? ok("mia-data-dir-writable", "Data directory writable", resolveServerDataDir())
        : error(
            "mia-data-dir-writable",
            "Data directory writable",
            `Cannot write to ${resolveServerDataDir()}`,
            "Fix permissions or choose another MIA_DATA_DIR.",
          ),
    )
  }

  const cookieSecret = env.get("MIA_COOKIE_SECRET")
  if (layout.isProduction) {
    checks.push(
      cookieSecret && cookieSecret.length >= 16
        ? ok("cookie-secret", "Session secret", "MIA_COOKIE_SECRET is set")
        : error(
            "cookie-secret",
            "Session secret",
            "MIA_COOKIE_SECRET must be at least 16 characters in production",
            "Run npm run setup to generate one.",
          ),
    )
  } else if (!cookieSecret) {
    checks.push(
      warn(
        "cookie-secret",
        "Session secret",
        "MIA_COOKIE_SECRET unset — dev-only default at runtime",
        "Required when NODE_ENV=production.",
      ),
    )
  } else {
    checks.push(ok("cookie-secret", "Session secret", "MIA_COOKIE_SECRET is set"))
  }

  if (layout.packaged) {
    const uiDist = resolveUiDist()
    checks.push(
      existsSync(resolve(uiDist, "index.html"))
        ? ok("ui-dist", "Dashboard bundle", uiDist)
        : error(
            "ui-dist",
            "Dashboard bundle",
            `Missing UI at ${uiDist}`,
            "Rebuild with npm run package.",
          ),
    )
  }

  const deployArtifacts = resolve(layout.projectRoot, "deploy/sync/artifacts")
  checks.push(
    existsSync(deployArtifacts)
      ? ok("deploy-artifacts", "Sync seed artifacts", deployArtifacts)
      : warn(
          "deploy-artifacts",
          "Sync seed artifacts",
          `Not found at ${deployArtifacts}`,
          "Entity boot-seed may be unavailable.",
        ),
  )

  const llmProvider = env.get("LLM_PROVIDER")
  if (!llmProvider) {
    checks.push(
      error(
        "llm-provider",
        "LLM provider",
        "LLM_PROVIDER is not set in .env",
        "Set LLM_PROVIDER=copilot-chat or LLM_PROVIDER=databricks (written to SQLite on each boot).",
      ),
    )
  } else if (!isLlmProvider(llmProvider)) {
    checks.push(
      error(
        "llm-provider",
        "LLM provider",
        `Invalid LLM_PROVIDER="${llmProvider}"`,
        "Allowed: copilot-chat, databricks",
      ),
    )
  } else if (llmProvider === "databricks") {
    checks.push(
      isDatabricksConfigured()
        ? ok(
            "llm-databricks",
            "Databricks LLM",
            `host ${env.get("DATABRICKS_HOST")} · ${databricksAuthMode(env) === "m2m" ? "M2M" : "PAT"}`,
          )
        : error(
            "llm-databricks",
            "Databricks LLM",
            "LLM_PROVIDER=databricks but DATABRICKS_HOST and credentials are missing",
            "Set DATABRICKS_HOST plus DATABRICKS_CLIENT_ID/SECRET or DATABRICKS_TOKEN in .env",
          ),
    )
  } else {
    checks.push(
      ok("llm-copilot", "LLM provider", "copilot-chat (authorize via Device Flow on first chat)"),
    )
  }

  const workspace = env.get("AGENT_WORKSPACE") ?? layout.projectRoot
  checks.push(
    isWritableDir(workspace, false)
      ? ok("agent-workspace", "Agent workspace", workspace)
      : error(
          "agent-workspace",
          "Agent workspace",
          `Not writable: ${workspace}`,
          "Set AGENT_WORKSPACE in .env",
        ),
  )

  const portRaw = env.get("PORT") ?? "3102"
  const port = Number(portRaw)
  checks.push(
    Number.isInteger(port) && port > 0 && port < 65536
      ? ok("port", "HTTP port", String(port))
      : error("port", "HTTP port", `Invalid PORT="${portRaw}"`, "Use 1–65535."),
  )

  if (hasMssqlConfigured(env)) {
    checks.push(
      ok(
        "mssql",
        "MSSQL",
        env.get("MSSQL_DATABASES") ? "MSSQL_DATABASES configured" : `host ${env.get("MSSQL_HOST") || env.get("MSSQL_SERVER")}`,
      ),
    )
    const bundlePath = resolve(layout.projectRoot, PUBLISHED_SYNC_BUNDLE_PATH)
    checks.push(
      isPublishedSyncBundlePresent(layout.projectRoot)
        ? ok("published-sync-bundle", "Published sync bundle", bundlePath)
        : warn(
            "published-sync-bundle",
            "Published sync bundle",
            "Not published yet — normal before first server start",
            "After first start: Entity Registry → ⚙ → Publish (required for sync preview/execute).",
          ),
    )
    const knowledge = env.get("MSSQL_KNOWLEDGE_FILE")
    if (knowledge && !existsSync(resolve(layout.projectRoot, knowledge))) {
      checks.push(
        warn("mssql-knowledge", "MSSQL knowledge file", `Not found: ${knowledge}`),
      )
    }
    const tenantConfig = env.get("MIA_TENANT_CONFIG")
    if (tenantConfig && !existsSync(resolve(layout.projectRoot, tenantConfig))) {
      checks.push(
        warn("tenant-config", "Tenant config", `Not found: ${tenantConfig}`),
      )
    }
  } else {
    checks.push(
      warn(
        "mssql",
        "MSSQL",
        "Not in .env — chat works; sync and schema catalog need MSSQL_*",
      ),
    )
  }

  return { layout, checks }
}

export function hasBlockingErrors(report: SetupReport): boolean {
  return report.checks.some((c) => c.severity === "error")
}

export function formatSetupReport(report: SetupReport): string {
  const lines: string[] = []
  lines.push(`MI:A setup — ${report.layout.packaged ? "release" : "development"}`)
  lines.push(`Project root: ${report.layout.projectRoot}`)
  lines.push("")
  for (const check of report.checks) {
    const icon = check.severity === "ok" ? "✓" : check.severity === "warn" ? "!" : "✗"
    lines.push(`  ${icon}  ${check.label}: ${check.message}`)
    if (check.hint && check.severity !== "ok") lines.push(`      → ${check.hint}`)
  }
  const errors = report.checks.filter((c) => c.severity === "error").length
  const warns = report.checks.filter((c) => c.severity === "warn").length
  lines.push("")
  if (errors > 0) lines.push(`${errors} blocking issue(s).`)
  else if (warns > 0) lines.push(`${warns} warning(s) — server can start.`)
  else lines.push("All checks passed.")
  return lines.join("\n")
}

export function formatLlmBootNote(): string {
  return [
    "LLM at runtime:",
    "  · .env LLM_PROVIDER is required — copied into SQLite llm_config on every boot.",
    "  · copilot-chat on laptops; databricks + DATABRICKS_* on corp hosts.",
    "  · Migration placeholder row is always overwritten; no silent DB default at runtime.",
  ].join("\n")
}
