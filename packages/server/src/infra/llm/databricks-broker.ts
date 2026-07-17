/**
 * Databricks token resolver — minimal, martai-style.
 *
 * Two ways to authenticate, in priority order:
 *   1. DATABRICKS_TOKEN — a Personal Access Token (PAT). Used as-is, no
 *      refresh, exactly like martai. This is the simple path.
 *   2. DATABRICKS_CLIENT_ID + DATABRICKS_CLIENT_SECRET — service principal
 *      M2M (client_credentials grant against /oidc/v1/token). The token is
 *      cached in-memory until it expires; concurrent refresh races are fine
 *      (worst case: one extra token request, no functional harm).
 */

import { LlmInteractionKind } from "@mia/shared-enums"
import {
  emitLlmInteractionRequired,
  getLlmOperationContext,
} from "./operation-context.js"

interface CachedToken {
  token: string
  expiresAt: number
}
let cached: CachedToken | null = null

export function isDatabricksConfigured(): boolean {
  return Boolean(
    process.env["DATABRICKS_HOST"] &&
    (process.env["DATABRICKS_TOKEN"] ||
      (process.env["DATABRICKS_CLIENT_ID"] && process.env["DATABRICKS_CLIENT_SECRET"]))
  )
}

export function getDatabricksHost(): string {
  const host = process.env["DATABRICKS_HOST"]
  if (!host) throw new Error("DATABRICKS_HOST not set")
  return host.replace(/\/$/, "")
}

/** Returns a valid bearer token (PAT or fresh M2M). */
export async function getDatabricksToken(): Promise<string> {
  const pat = process.env["DATABRICKS_TOKEN"]
  if (pat) return pat

  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token

  const clientId = process.env["DATABRICKS_CLIENT_ID"]
  const clientSecret = process.env["DATABRICKS_CLIENT_SECRET"]
  if (!clientId || !clientSecret) throw new Error("Databricks not configured")

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  const res = await fetch(`${getDatabricksHost()}/oidc/v1/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=all-apis"
  })
  if (!res.ok) {
    const detail = await res.text()
    const err = new Error(`Databricks OAuth failed (${res.status}): ${detail}`)
    if (getLlmOperationContext()) {
      emitLlmInteractionRequired({
        provider: "databricks",
        kind: LlmInteractionKind.Configure,
        title: "Databricks authentication failed",
        message: err.message,
      })
    }
    throw err
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return cached.token
}
