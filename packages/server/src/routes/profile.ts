/**
 * Runtime profile route.
 *
 * Single, public read-only window onto the active deployment profile so
 * the UI (and operators) can see whether the server is running in hosted
 * or developer mode without grepping `console.log` output. The flag's
 * single source of truth is `getRunProfile()` in `run-workspace.ts`,
 * which reads `AGENT_HOSTED_MODE`.
 */

import type { FastifyInstance } from "fastify"
import { getOwnerUsage, getRetentionPolicy } from "../attachments/index.js"
import { getRunProfile } from "../run-workspace.js"

export function registerProfileRoutes(app: FastifyInstance): void {
  app.get("/api/runtime/profile", async () => {
    const profile = getRunProfile()
    return {
      profile,
      // Stable booleans the UI can branch on without string-matching.
      hosted: profile === "hosted",
    }
  })

  // Per-session attachment quota visibility. Anonymous callers get a
  // synthetic "no owner" view (zero used, full quota) so the UI can still
  // render meaningful defaults before sign-in.
  app.get("/api/runtime/attachment-usage", async (req) => {
    const ownerUpn = req.session.upn
    const usage = getOwnerUsage(ownerUpn)
    const retention = getRetentionPolicy()
    return {
      ownerUpn,
      ...usage,
      retention: {
        runDays:            retention.runDays,
        sessionDays:        retention.sessionDays,
        workspaceAssetDays: retention.workspaceAssetDays,
      },
    }
  })
}
