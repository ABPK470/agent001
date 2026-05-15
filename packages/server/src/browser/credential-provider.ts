/**
 * Server-side credential resolver for the agent's `browser_auto_login`
 * tool. Bridges {@link BrowserCredentialProvider} to the SQLite-backed
 * vault store. Anonymous tenants (no upn) get null for every lookup.
 *
 * @module
 */

import { generateSync, type HashAlgorithm } from "otplib"

import type { BrowserCredentialProvider } from "@mia/agent"

import { getCurrentSession } from "../auth/context.js"
import {
    openCredential,
    type PasswordPayload,
    type TotpPayload,
} from "./credentials.js"

export const serverBrowserCredentialProvider: BrowserCredentialProvider = {
  async resolvePassword(id) {
    const session = getCurrentSession()
    if (!session?.upn) return null

    const opened = openCredential<PasswordPayload>(session.upn, id)
    if (!opened) return null
    if (opened.metadata.kind !== "password") return null

    return {
      label: opened.metadata.label,
      targetOrigin: opened.metadata.targetOrigin,
      username: opened.payload.username,
      password: opened.payload.password,
    }
  },

  async resolveTotp(id) {
    const session = getCurrentSession()
    if (!session?.upn) return null

    const opened = openCredential<TotpPayload>(session.upn, id)
    if (!opened) return null
    if (opened.metadata.kind !== "totp") return null

    // otplib v13 functional API — synchronous, no global state.
    const code = generateSync({
      secret: opened.payload.secret,
      strategy: "totp",
      digits: opened.payload.digits ?? 6,
      period: opened.payload.period ?? 30,
      algorithm: (opened.payload.algorithm ?? "sha1") as HashAlgorithm,
    })

    return {
      label: opened.metadata.label,
      targetOrigin: opened.metadata.targetOrigin,
      code,
    }
  },
}
