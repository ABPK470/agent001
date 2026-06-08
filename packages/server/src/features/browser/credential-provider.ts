/**
 * Server-side credential resolver for the agent's `browser_auto_login`
 * tool. Bridges {@link BrowserCredentialProvider} to the SQLite-backed
 * vault store. The server binds the owner UPN explicitly when it
 * constructs the provider for a run; anonymous runs get null.
 *
 * @module
 */

import { generateSync, type HashAlgorithm } from "otplib"

import type { BrowserCredentialProvider } from "@mia/agent"

import { openCredential, type PasswordPayload, type TotpPayload } from "./credentials.js"

export function createServerBrowserCredentialProvider(ownerUpn: string | null): BrowserCredentialProvider {
  return {
    async resolvePassword(id) {
      if (!ownerUpn) return null

      const opened = openCredential<PasswordPayload>(ownerUpn, id)
      if (!opened) return null
      if (opened.metadata.kind !== "password") return null

      return {
        label: opened.metadata.label,
        targetOrigin: opened.metadata.targetOrigin,
        username: opened.payload.username,
        password: opened.payload.password
      }
    },

    async resolveTotp(id) {
      if (!ownerUpn) return null

      const opened = openCredential<TotpPayload>(ownerUpn, id)
      if (!opened) return null
      if (opened.metadata.kind !== "totp") return null

      // otplib v13 functional API — synchronous, no global state.
      const code = generateSync({
        secret: opened.payload.secret,
        strategy: "totp",
        digits: opened.payload.digits ?? 6,
        period: opened.payload.period ?? 30,
        algorithm: (opened.payload.algorithm ?? "sha1") as HashAlgorithm
      })

      return {
        label: opened.metadata.label,
        targetOrigin: opened.metadata.targetOrigin,
        code
      }
    }
  }
}

export const serverBrowserCredentialProvider: BrowserCredentialProvider =
  createServerBrowserCredentialProvider(null)
