/**
 * Runtime profile transport routes.
 */

import type { FastifyInstance } from "fastify"
import { getOwnerUsage, getRetentionPolicy } from "../../infra/persistence/attachments.js"
import { getRunProfile } from "../runs/workspace/index.js"

export function registerProfileRoutes(app: FastifyInstance): void {
  app.get("/api/state/profile", async () => {
    const profile = getRunProfile()
    return {
      profile,
      hosted: profile === "hosted"
    }
  })

  app.get("/api/state/attachment-usage", async (req) => {
    const ownerUpn = req.session.upn
    const usage = getOwnerUsage(ownerUpn)
    const retention = getRetentionPolicy()
    return {
      ownerUpn,
      ...usage,
      retention: {
        runDays: retention.runDays,
        userDraftDays: retention.userDraftDays,
        workspaceAssetDays: retention.workspaceAssetDays
      }
    }
  })
}
