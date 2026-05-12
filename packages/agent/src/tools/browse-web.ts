/**
 * browse_web tool — interactive web browsing with a persistent browser session.
 *
 * Unlike fetch_url (read-only), this tool gives the agent a full headless browser
 * that persists across multiple tool calls. The agent can navigate, click, type,
 * scroll, and read — enabling real web interactions like filling forms, dismissing
 * cookie banners, and multi-page flows.
 *
 * Security:
 *   - Same SSRF protections as fetch_url (DNS pre-resolve, private IP blocking)
 *   - Navigation to private/internal addresses blocked at each hop
 *   - Sessions auto-close after 5 minutes of inactivity
 *
 * Internals split into ./browse-web/<module>:
 *   ssrf          — URL/IP validation
 *   session       — BrowserSession lifecycle + kill-signal guard
 *   page-helpers  — cookie dismissal + text extraction
 *   actions       — per-action handlers
 *
 * @module
 */

import type { Tool } from "../types.js"
import {
    handleClick,
    handleClose,
    handleNavigate,
    handleRead,
    handleScroll,
    handleType,
} from "./browse-web/actions.js"
import { getKillSignal, getSession } from "./browse-web/session.js"

// Re-export public helpers for backwards compatibility
export { closeAllBrowserSessions, setBrowseKillSignal } from "./browse-web/session.js"
export type { BrowserSession } from "./browse-web/session.js"

export const browseWebTool: Tool = {
  name: "browse_web",
  description:
    "Interactive web browsing with a persistent browser session. " +
    "Actions: navigate (open URL), click (CSS selector or button text), " +
    "type (into input field), scroll (up/down), read (get current page text), close (end session). " +
    "Returns page text after each action. Use for complex web interactions " +
    "(forms, cookie consent, multi-page flows). For simple reads, prefer fetch_url. " +
    "Set visible=true on navigate to open a browser window the user can see — " +
    "use with ask_user when the user needs to complete a step (CAPTCHA, payment, 2FA).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "click", "type", "scroll", "read", "close"],
        description: "The browser action to perform.",
      },
      url: {
        type: "string",
        description: "URL to navigate to (for 'navigate' action).",
      },
      visible: {
        type: "boolean",
        description:
          "Set to true to open a visible browser window the user can see and interact with. " +
          "Use when the user needs to take over (CAPTCHA, payment, login). Default: false (headless).",
      },
      selector: {
        type: "string",
        description:
          "CSS selector for the target element (for 'click' and 'type'). " +
          "If the CSS selector isn't found, text content matching is attempted for clicks.",
      },
      text: {
        type: "string",
        description: "Text to type (for 'type' action). End with a newline to press Enter after typing.",
      },
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "Scroll direction (default: 'down').",
      },
      session_id: {
        type: "string",
        description:
          "Session ID returned by a previous 'navigate' call. " +
          "Omit to start a new session. Required for all actions except 'navigate'.",
      },
      max_length: {
        type: "number",
        description: "Max characters of page text to return (default: 10000).",
      },
    },
    required: ["action"],
  },

  async execute(args) {
    const action = String(args.action)
    const sessionId = args.session_id ? String(args.session_id) : undefined
    const maxLength = Number(args.max_length ?? 10000)

    // If kill signal already fired before we start, bail immediately
    if (getKillSignal()?.aborted) return "Error: Tool execution cancelled"

    if (action === "navigate") {
      return handleNavigate({
        url: String(args.url ?? ""),
        visible: Boolean(args.visible),
        sessionId,
        maxLength,
      })
    }

    // All remaining actions require a session
    if (!sessionId) return "Error: 'session_id' is required. Use 'navigate' first to start a session."
    const s = getSession(sessionId)
    if (typeof s === "string") return s
    const session = s

    switch (action) {
      case "click":
        return handleClick(session, sessionId, String(args.selector ?? ""), maxLength)
      case "type":
        return handleType(session, sessionId, String(args.selector ?? ""), String(args.text ?? ""), maxLength)
      case "scroll":
        return handleScroll(session, sessionId, String(args.direction ?? "down"), maxLength)
      case "read":
        return handleRead(session, sessionId, maxLength)
      case "close":
        return handleClose(session, sessionId)
      default:
        return `Error: Unknown action "${action}". Use: navigate, click, type, scroll, read, close.`
    }
  },
}
