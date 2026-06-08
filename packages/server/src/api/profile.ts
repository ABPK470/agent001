/**
 * Runtime profile transport routes.
 */

import type { FastifyInstance } from "fastify"
import { getOwnerUsage, getRetentionPolicy } from "../adapters/persistence/attachments.js"
import { getRunProfile } from "../application/shell/workspace/run-workspace.js"

export function registerProfileRoutes(app: FastifyInstance): void {
  app.get("/api/runtime/profile", async () => {
    const profile = getRunProfile()
    return {
      profile,
      hosted: profile === "hosted"
    }
  })

  app.get("/api/runtime/attachment-usage", async (req) => {
    const ownerUpn = req.session.upn
    const usage = getOwnerUsage(ownerUpn)
    const retention = getRetentionPolicy()
    return {
      ownerUpn,
      ...usage,
      retention: {
        runDays: retention.runDays,
        sessionDays: retention.sessionDays,
        workspaceAssetDays: retention.workspaceAssetDays
      }
    }
  })
}
