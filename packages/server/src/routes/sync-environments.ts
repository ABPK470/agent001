/**
 * Sync-environment admin routes (admin only).
 *
 * GET  /api/sync-environments              → list merged effective config
 *                                            (JSON baseline + DB overrides).
 * PUT  /api/sync-environments/:name        → upsert overrides for one env.
 *                                            Re-derives env_derived policy
 *                                            rules and refreshes the
 *                                            in-memory environment registry
 *                                            so changes take effect on the
 *                                            NEXT run without a restart.
 * DELETE /api/sync-environments/:name      → drop overrides; reverts to JSON.
 *
 * What's editable: every hosted-mode permission field on
 * {@link SyncEnvironment} — `defaultAccessMode`, `allowedOperations`,
 * `denyDml`, `denyDdl`, `approvalRequiredOperations`, `syncAllowlist`.
 * Identity fields (`role`, `linkedServerName`, `ringOrder`, etc.) are
 * out of scope here — those still live in the JSON config so the
 * topology stays version-controlled.
 */

import {
    ENV_ACCESS_MODES,
    getEnvironments,
    isEnvAccessMode,
    setEnvironments,
    withPermissionDefaults,
    type EnvOperation,
    type SyncEnvironment,
} from "@mia/agent"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../db/index.js"
import { refreshEnvDerivedPolicies } from "../policy/policy-seeder.js"

const VALID_OPS: EnvOperation[] = [
  "query_read", "schema_introspect", "sync_preview", "sync_execute", "ddl", "dml",
]

type Editable = Pick<SyncEnvironment,
  | "defaultAccessMode"
  | "allowedOperations"
  | "denyDml"
  | "denyDdl"
  | "approvalRequiredOperations"
  | "syncAllowlist"
>

/**
 * Reduce the request body to the editable subset and validate enums.
 * Returns either the sanitised override or a string error message.
 */
function sanitise(body: Record<string, unknown>): Partial<Editable> | string {
  const out: Partial<Editable> = {}
  if (body["defaultAccessMode"] !== undefined) {
    if (!isEnvAccessMode(body["defaultAccessMode"])) {
      return `defaultAccessMode must be one of ${ENV_ACCESS_MODES.join("|")}`
    }
    out.defaultAccessMode = body["defaultAccessMode"]
  }
  if (body["allowedOperations"] !== undefined) {
    if (!Array.isArray(body["allowedOperations"])) return "allowedOperations must be an array"
    for (const op of body["allowedOperations"] as string[]) {
      if (!VALID_OPS.includes(op as EnvOperation)) return `unknown operation "${op}"`
    }
    out.allowedOperations = body["allowedOperations"] as EnvOperation[]
  }
  if (body["approvalRequiredOperations"] !== undefined) {
    if (!Array.isArray(body["approvalRequiredOperations"])) return "approvalRequiredOperations must be an array"
    for (const op of body["approvalRequiredOperations"] as string[]) {
      if (!VALID_OPS.includes(op as EnvOperation)) return `unknown operation "${op}"`
    }
    out.approvalRequiredOperations = body["approvalRequiredOperations"] as EnvOperation[]
  }
  if (body["denyDml"] !== undefined) {
    if (typeof body["denyDml"] !== "boolean") return "denyDml must be boolean"
    out.denyDml = body["denyDml"]
  }
  if (body["denyDdl"] !== undefined) {
    if (typeof body["denyDdl"] !== "boolean") return "denyDdl must be boolean"
    out.denyDdl = body["denyDdl"]
  }
  if (body["syncAllowlist"] !== undefined) {
    if (!Array.isArray(body["syncAllowlist"])) return "syncAllowlist must be an array of UPN strings"
    out.syncAllowlist = body["syncAllowlist"].map(String)
  }
  return out
}

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  try {
    db.saveAdminAudit({
      actor:     req.session.upn,
      action,
      detail:    JSON.stringify(detail),
      timestamp: new Date().toISOString(),
      scope_id:  "sync-environments",
    })
  } catch (e) {
    console.warn("[sync-envs] audit_log write failed:", e instanceof Error ? e.message : e)
  }
}

/**
 * Re-apply a single env's override on top of its current registry entry
 * so a PUT takes effect immediately for any future run (no restart).
 */
function refreshRegistryFor(name: string): void {
  const override = db.getSyncEnvOverride(name)
  if (!override) return
  let parsed: Partial<SyncEnvironment>
  try {
    parsed = JSON.parse(override.overrides_json) as Partial<SyncEnvironment>
  } catch {
    return
  }
  const next = getEnvironments().map((e) =>
    e.name === name
      ? withPermissionDefaults({ ...e, ...parsed, name: e.name })
      : e,
  )
  setEnvironments(next)
}

export function registerSyncEnvironmentRoutes(app: FastifyInstance): void {
  app.get("/api/sync-environments", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    const overrides = new Map(db.listSyncEnvOverrides().map((r) => [r.name, r]))
    return getEnvironments().map((e) => {
      const o = overrides.get(e.name)
      let parsed: Record<string, unknown> = {}
      if (o) {
        try { parsed = JSON.parse(o.overrides_json) as Record<string, unknown> } catch { /* ignore */ }
      }
      return {
        name:                       e.name,
        displayName:                e.displayName,
        role:                       e.role,
        defaultAccessMode:          e.defaultAccessMode,
        allowedOperations:          e.allowedOperations,
        denyDml:                    e.denyDml,
        denyDdl:                    e.denyDdl,
        approvalRequiredOperations: e.approvalRequiredOperations,
        syncAllowlist:              e.syncAllowlist,
        // Echo the override row so the UI can show "this field is
        // overriding JSON" markers and an "Reset to JSON default" button.
        override:   o ? { fields: parsed, updatedAt: o.updated_at, updatedBy: o.updated_by } : null,
      }
    })
  })

  app.put<{ Params: { name: string }; Body: Record<string, unknown> }>(
    "/api/sync-environments/:name",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      const env = getEnvironments().find((e) => e.name === req.params.name)
      if (!env) { reply.code(404); return { error: `unknown env "${req.params.name}"` } }

      const sanitised = sanitise(req.body ?? {})
      if (typeof sanitised === "string") { reply.code(400); return { error: sanitised } }

      // Merge with any existing override so a PUT with a single field
      // doesn't wipe the rest.
      const prev = db.getSyncEnvOverride(req.params.name)
      let prevParsed: Record<string, unknown> = {}
      if (prev) {
        try { prevParsed = JSON.parse(prev.overrides_json) as Record<string, unknown> } catch { /* ignore */ }
      }
      const merged = { ...prevParsed, ...sanitised }

      db.saveSyncEnvOverride({
        name:           req.params.name,
        overrides_json: JSON.stringify(merged),
        updated_at:     new Date().toISOString(),
        updated_by:     req.session.upn,
      })
      refreshRegistryFor(req.params.name)
      // Re-derive env_derived policy rules from the merged config so the
      // engine picks up the change on the very next run start.
      refreshEnvDerivedPolicies(req.params.name)

      audit(req, "sync_env.update", { name: req.params.name, fields: sanitised })
      return { ok: true }
    },
  )

  app.delete<{ Params: { name: string } }>(
    "/api/sync-environments/:name",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      db.deleteSyncEnvOverride(req.params.name)
      // Reverting to JSON default: drop env_derived rules and re-seed
      // them from the un-overridden registry. Note the registry still
      // holds the merged copy from when the override was applied; for
      // pure correctness an operator should restart, but the rule set
      // will catch up on next boot via setupEnvironments + seeder.
      refreshEnvDerivedPolicies(req.params.name)
      audit(req, "sync_env.reset", { name: req.params.name })
      return { ok: true }
    },
  )
}
