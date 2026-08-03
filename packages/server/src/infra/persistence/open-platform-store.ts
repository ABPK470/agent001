/**
 * Boot composition — open the configured platform store, migrate, seed.
 *
 * SQLite: existing openDatabase path (sync migrate/seeds/memory FTS).
 * MSSQL: single Kysely handle + multi-dialect registry; memory FTS deferred (m8).
 */

import { PolicyEffect } from "@mia/agent"
import { loadStrategiesArtifact } from "@mia/sync"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PolicySource } from "../../internal/enums/index.js"
import {
  llmEnvOptional,
  readLlmEnvOverride,
} from "../llm/env-override.js"
import { openMssqlPlatformStore } from "./adapters/mssql/platform-store.js"
import { getDbPath, openDatabase } from "./adapters/sqlite/index.js"
import { runChangesAsync, runExecAsync } from "./schema/execute-async.js"
import { getPlatformDb } from "./schema/kysely.js"
import { platformNow } from "./schema/sql-time.js"
import { insertRowOrIgnoreAsync } from "./schema/upsert.js"
import { resolvePlatformStoreKind } from "./platform-store-config.js"
import {
  _resetPlatformStoreCacheForTests,
  _setPlatformStoreCache,
} from "./platform-store.js"

const DEFAULT_TENANT = "_default"
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..")

let mssqlClose: (() => Promise<void>) | null = null

export async function closeOpenedPlatformStore(): Promise<void> {
  if (mssqlClose) {
    await mssqlClose()
    mssqlClose = null
  }
  _resetPlatformStoreCacheForTests()
}

async function runSeedsAsync(projectRoot = REPO_ROOT): Promise<void> {
  getPlatformDb()
  const artifact = loadStrategiesArtifact(resolve(projectRoot))
  const now = new Date().toISOString()
  for (const strategy of artifact.strategies) {
    await insertRowOrIgnoreAsync({
      table: "scd2_strategy_active",
      keys: { tenant_id: DEFAULT_TENANT, id: strategy.id },
      insert: {
        tenant_id: DEFAULT_TENANT,
        id: strategy.id,
        current_version: strategy.version,
        retired_at: null,
      },
    })
    await insertRowOrIgnoreAsync({
      table: "scd2_strategy_versions",
      keys: {
        tenant_id: DEFAULT_TENANT,
        id: strategy.id,
        version: strategy.version,
      },
      insert: {
        tenant_id: DEFAULT_TENANT,
        id: strategy.id,
        version: strategy.version,
        body_json: JSON.stringify(strategy),
        created_by: strategy.createdBy,
        created_at: strategy.createdAt ?? now,
        reason: "shipped",
      },
    })
  }

  const seedPolicies: { name: string; effect: PolicyEffect; condition: string; parameters: string }[] =
    [
      {
        name: "Tool Permission",
        effect: PolicyEffect.Allow,
        condition: "tool_call",
        parameters: JSON.stringify({
          scope: "all_tools",
          description: "Controls which tools agents are permitted to invoke",
        }),
      },
      {
        name: "Model",
        effect: PolicyEffect.Allow,
        condition: "model_selection",
        parameters: JSON.stringify({
          scope: "all_models",
          description: "Controls model selection and usage limits",
        }),
      },
      {
        name: "Security",
        effect: PolicyEffect.RequireApproval,
        condition: "sensitive_action",
        parameters: JSON.stringify({
          scope: "destructive_ops",
          description: "Requires approval for destructive or sensitive operations",
        }),
      },
    ]
  for (const p of seedPolicies) {
    await insertRowOrIgnoreAsync({
      table: "policy_configs",
      keys: { name: p.name },
      insert: {
        name: p.name,
        effect: p.effect,
        condition: p.condition,
        parameters: p.parameters,
        created_at: now,
        source: PolicySource.HostedDefault,
        updated_at: null,
        updated_by: null,
      },
    })
  }
}

async function applyLlmEnvOverrideAsync(): Promise<boolean> {
  const override = readLlmEnvOverride()
  if (!override) {
    if (llmEnvOptional()) return false
    throw new Error(
      "LLM_PROVIDER is not set in .env — run npm run setup or set LLM_PROVIDER=copilot-chat|databricks",
    )
  }
  getPlatformDb()
  const updated = await runChangesAsync(
    getPlatformDb()
      .updateTable("llm_config")
      .set({
        provider: override.provider,
        model: override.model,
        api_key: override.api_key,
        base_url: override.base_url,
        updated_at: platformNow(),
      })
      .where("id", "=", 1)
      .compile(),
  )
  if (updated === 0) {
    await runExecAsync(
      getPlatformDb()
        .insertInto("llm_config")
        .values({
          id: 1,
          provider: override.provider,
          model: override.model,
          api_key: override.api_key,
          base_url: override.base_url,
          updated_at: platformNow(),
        })
        .compile(),
    )
  }
  console.log(`[boot] llm_config set from .env: ${override.provider} / ${override.model}`)
  return true
}

export type OpenPlatformStoreResult = {
  kind: "sqlite" | "mssql"
  location: string
}

/**
 * Open + migrate + seed the platform store for the configured kind.
 * Call once at server boot before product traffic.
 */
export async function openConfiguredPlatformStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenPlatformStoreResult> {
  const kind = resolvePlatformStoreKind(env)
  if (kind === "postgres") {
    throw new Error(
      "MIA_PLATFORM_STORE=postgres is not ready — use sqlite (local) or mssql (hosted).",
    )
  }
  if (kind === "sqlite") {
    openDatabase()
    return { kind: "sqlite", location: getDbPath() }
  }

  const handle = await openMssqlPlatformStore(env)
  await handle.applyMigrations()
  await runSeedsAsync()
  await applyLlmEnvOverrideAsync()
  _setPlatformStoreCache(handle)
  mssqlClose = () => handle.close()
  return {
    kind: "mssql",
    location: `${env["MIA_PLATFORM_MSSQL_SERVER"]}/${env["MIA_PLATFORM_MSSQL_DATABASE"]}`,
  }
}
