/**
 * browser_auto_login — drives a sign-in flow against an existing browser
 * session using a vault-stored credential.
 *
 * Security:
 *   - Refused entirely when no {@link BrowserCredentialProvider} is
 *     installed (CLI / tests / anonymous tenant). Anonymous sessions
 *     never get a provider.
 *   - The credential payload (password, TOTP secret) NEVER leaves the
 *     server process: passwords are typed via `keyboard.type()` straight
 *     into Playwright; TOTP codes are generated server-side from the
 *     stored seed and only the 6-digit code is handed back to the agent.
 *   - Selectors use the same prefix routing as `browse_web` so the agent
 *     can target any login form.
 *
 * The agent supplies the field selectors and (optionally) a submit
 * selector. Returns the post-submit page text.
 *
 * @module
 */

import type { AgentHost } from "../application/shell/runtime.js"
import type { Tool } from "../domain/agent-types.js"
import { resolveLocator } from "./browse-web/selectors.js"
import { getKillSignal, getSession, persistSessionState } from "./browse-web/session.js"

const BROWSER_AUTO_LOGIN_DESCRIPTION =
    "Auto-fill and submit a login form on the active browse_web session using a stored credential. " +
    "Resolves the credential via the per-tenant vault (cross-tenant access is refused). " +
    "Use mode='password' for { username, password } credentials and mode='totp' to type a fresh TOTP code. " +
    "Selector strings accept the same prefixes as browse_web ('css:', 'xpath:', 'text:', 'role:')."

const BROWSER_AUTO_LOGIN_PARAMETERS = {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Active browse_web session id." },
      credential_id: { type: "string", description: "Credential id (must belong to the current user)." },
      mode: {
        type: "string",
        enum: ["password", "totp"],
        description:
          "'password' fills username + password fields; 'totp' types the current 6-digit code into one field.",
      },
      username_selector: {
        type: "string",
        description: "Selector for the username/email field (mode='password' only).",
      },
      password_selector: {
        type: "string",
        description: "Selector for the password field (mode='password' only).",
      },
      code_selector: {
        type: "string",
        description: "Selector for the TOTP code field (mode='totp' only).",
      },
      submit_selector: {
        type: "string",
        description: "Optional selector to click after filling. If omitted, presses Enter.",
      },
    },
    required: ["session_id", "credential_id", "mode"],
  } as const

export const browserAutoLoginTool: Tool = {
  name: "browser_auto_login",
  description: BROWSER_AUTO_LOGIN_DESCRIPTION,
  parameters: BROWSER_AUTO_LOGIN_PARAMETERS,
  async execute(_args) {
    throw new Error("browserAutoLoginTool must be built via createBrowserAutoLoginTool(host)")
  },
}

export function createBrowserAutoLoginTool(host: AgentHost): Tool {
  return {
    name: "browser_auto_login",
    description: BROWSER_AUTO_LOGIN_DESCRIPTION,
    parameters: BROWSER_AUTO_LOGIN_PARAMETERS,
    async execute(args) {
      const provider = host.browser.credentialReader
      if (!provider) {
        return "Error: credential vault is not configured for this runtime (anonymous session or non-server host)."
      }

      if (getKillSignal()?.aborted) return "Error: Tool execution cancelled"

      const sessionId = String(args.session_id ?? "")
      const credentialId = String(args.credential_id ?? "")
      const mode = String(args.mode ?? "")
      if (!sessionId) return "Error: 'session_id' is required"
      if (!credentialId) return "Error: 'credential_id' is required"

      const sess = getSession(host, sessionId)
      if (typeof sess === "string") return sess
      const session = sess
      const target = session.frame ?? session.page

      const submitSelector = args.submit_selector ? String(args.submit_selector) : undefined

      try {
        if (mode === "password") {
          const usernameSelector = String(args.username_selector ?? "")
          const passwordSelector = String(args.password_selector ?? "")
          if (!usernameSelector || !passwordSelector) {
            return "Error: 'username_selector' and 'password_selector' are required for mode='password'"
          }
          const cred = await provider.resolvePassword(credentialId)
          if (!cred) return `Error: credential "${credentialId}" not found for this user`

          const userLoc = resolveLocator(target, usernameSelector)
          await userLoc.first().waitFor({ timeout: 5000 })
          await userLoc.first().click({ clickCount: 3 })
          await userLoc.first().pressSequentially(cred.username, { delay: 30 })

          const passLoc = resolveLocator(target, passwordSelector)
          await passLoc.first().waitFor({ timeout: 5000 })
          await passLoc.first().click({ clickCount: 3 })
          await passLoc.first().pressSequentially(cred.password, { delay: 30 })
        } else if (mode === "totp") {
          const codeSelector = String(args.code_selector ?? "")
          if (!codeSelector) return "Error: 'code_selector' is required for mode='totp'"
          const cred = await provider.resolveTotp(credentialId)
          if (!cred) return `Error: credential "${credentialId}" not found for this user`

          const codeLoc = resolveLocator(target, codeSelector)
          await codeLoc.first().waitFor({ timeout: 5000 })
          await codeLoc.first().click({ clickCount: 3 })
          await codeLoc.first().pressSequentially(cred.code, { delay: 30 })
        } else {
          return `Error: unknown mode "${mode}". Use 'password' or 'totp'.`
        }

        if (submitSelector) {
          const submitLoc = resolveLocator(target, submitSelector)
          await submitLoc.first().click()
        } else {
          await session.page.keyboard.press("Enter")
        }
        await session.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})
        session.url = session.page.url()

        // Persist storage state so the cookie set by login survives the
        // session timeout — same path as handleClose.
        persistSessionState(session).catch(() => {})

        const text = await session.page
          .evaluate("document.body?.innerText?.slice(0, 4000) ?? ''")
          .catch(() => "")
        return `[Session: ${sessionId}] [URL: ${session.page.url()}]\nLogin submitted.\n\n${text}`
      } catch (err) {
        return `Error during auto-login: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}
