/**
 * About dossier — what this instance is, and (for the viewer) what they
 * can use: personal usage, allowed dirs/tools, sync environments.
 *
 * Never includes secrets (API keys, passwords, cookie secrets, connection
 * strings with credentials).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentHost } from "@mia/agent"
import { getEnvironments } from "@mia/sync"
import * as db from "../../../infra/persistence/sqlite.js"
import { PROVIDER_DEFAULTS } from "../../../infra/llm/registry.js"
import { getPlatformHealth, type PlatformHealth } from "./platform-health-service.js"

export interface AboutDossier {
  product: {
    name: string
    version: string
  }
  runtime: {
    /** Human deployment label — MIA_ENV / APP_ENV if set, else NODE_ENV. */
    env: string
    node: string
  }
  viewer: {
    upn: string
    displayName: string
    isAdmin: boolean
    role: "admin" | "operator"
  }
  /** Personal totals for the signed-in user. */
  myUsage: {
    runs: { total: number; completed: number; failed: number }
    tokens: { prompt: number; completion: number; total: number; llmCalls: number }
    syncRuns: { total: number }
  }
  /** What this role may touch. */
  access: {
    directories: {
      allowed: string[]
      denied: string[]
    }
    tools: string[]
    widgets: string[]
    notes: string[]
  }
  /** Sync environments visible to the operator (no service URLs). */
  environments: Array<{
    name: string
    displayName: string
    role: string
    ringOrder: number
    defaultAccessMode: string
    allowedOperations: string[]
    denyDml: boolean
    denyDdl: boolean
    allowedSyncEnvironments: string[] | null
  }>
  /** Active provider/model + catalog of configured providers. */
  providers: {
    active: { id: string; model: string; configured: boolean }
    available: Array<{ id: string; defaultModel: string; label: string }>
  }
  workspace: {
    path: string
    /** Operators work in an isolated sandbox; admins use the full workspace. */
    mode: "full" | "sandbox"
  }
  execution: {
    sandboxMode: string
    hostedMode: boolean
    isolatedWorkspace: boolean
    maxConcurrentRuns: number | null
  }
  dataPlane: PlatformHealth
}

function readPackageVersion(projectRoot: string): string {
  try {
    const raw = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf-8")) as {
      version?: string
    }
    return raw.version?.trim() || "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function resolveEnvLabel(): string {
  const explicit =
    process.env.MIA_ENV?.trim() ||
    process.env.APP_ENV?.trim() ||
    process.env.DEPLOY_ENV?.trim()
  if (explicit) return explicit
  return process.env.NODE_ENV?.trim() || "development"
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw?.trim()) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

const PROVIDER_LABELS: Record<string, string> = {
  "copilot-chat": "GitHub Copilot Chat",
  databricks: "Databricks (serving endpoints)",
}

function buildAccess(isAdmin: boolean): AboutDossier["access"] {
  if (isAdmin) {
    return {
      directories: {
        allowed: ["Full agent workspace", "Platform data directory (via admin tools)"],
        denied: [],
      },
      tools: [],
      widgets: [],
      notes: [],
    }
  }
  return {
    directories: {
      allowed: [
        "Temporary folder for each of your runs (read / write / list)",
        "Files you attach to a run",
      ],
      denied: [
        "Project source tree on the host",
        "MI:A install / platform internals",
      ],
    },
    tools: [],
    widgets: [],
    notes: [
      "UAT/PROD database writes (DML/DDL) are blocked; DEV follows that environment’s access mode.",
      "Running a sync (execute) and outbound URL fetch typically need approval.",
    ],
  }
}

export function buildAboutDossier(opts: {
  projectRoot: string
  mssqlSummary: string
  bootHost: AgentHost
  workspacePath: string
  activeRuns: number
  queuePending: number
  viewer: { upn: string; displayName: string; isAdmin: boolean }
}): AboutDossier {
  void opts.activeRuns
  void opts.queuePending

  const isAdmin = opts.viewer.isAdmin
  const usage = db.getUsageTotalsForUser(opts.viewer.upn)
  const syncTotal = db.countSyncRuns({ actorUpn: opts.viewer.upn })
  const llm = db.getLlmConfig()
  const platformHealth = getPlatformHealth(opts.projectRoot, opts.mssqlSummary, opts.bootHost)

  const environments = getEnvironments(opts.bootHost)
    .slice()
    .sort((a, b) => a.ringOrder - b.ringOrder || a.name.localeCompare(b.name))
    .map((env) => ({
      name: env.name,
      displayName: env.displayName || env.name,
      role: String(env.role),
      ringOrder: env.ringOrder,
      defaultAccessMode: String(env.defaultAccessMode),
      allowedOperations: [...(env.allowedOperations ?? [])].map(String),
      denyDml: Boolean(env.denyDml),
      denyDdl: Boolean(env.denyDdl),
      allowedSyncEnvironments: env.allowedSyncEnvironments,
    }))

  const available = Object.entries(PROVIDER_DEFAULTS).map(([id, def]) => ({
    id,
    defaultModel: def.model,
    label: PROVIDER_LABELS[id] ?? id,
  }))

  return {
    product: {
      name: "MI:A",
      version: readPackageVersion(opts.projectRoot),
    },
    runtime: {
      env: resolveEnvLabel(),
      node: process.version,
    },
    viewer: {
      upn: opts.viewer.upn,
      displayName: opts.viewer.displayName,
      isAdmin,
      role: isAdmin ? "admin" : "operator",
    },
    myUsage: {
      runs: {
        total: usage.run_count,
        completed: usage.completed_runs,
        failed: usage.failed_runs,
      },
      tokens: {
        prompt: usage.total_prompt_tokens,
        completion: usage.total_completion_tokens,
        total: usage.total_tokens,
        llmCalls: usage.total_llm_calls,
      },
      syncRuns: { total: syncTotal },
    },
    access: buildAccess(isAdmin),
    environments,
    providers: {
      active: {
        id: llm.provider,
        model: llm.model,
        configured: llm.api_key.length > 0 || llm.provider === "databricks",
      },
      available,
    },
    workspace: {
      path: opts.workspacePath,
      mode: isAdmin ? "full" : "sandbox",
    },
    execution: {
      sandboxMode: process.env.SANDBOX_MODE?.trim() || "host",
      hostedMode: process.env.AGENT_HOSTED_MODE === "true",
      isolatedWorkspace: process.env.AGENT_ISOLATED_WORKSPACE !== "false",
      maxConcurrentRuns: parsePositiveInt(process.env.MAX_CONCURRENT_RUNS),
    },
    dataPlane: platformHealth,
  }
}
