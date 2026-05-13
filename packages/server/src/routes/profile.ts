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
}
