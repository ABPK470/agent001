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

import type { AgentHost, RunContext } from "../../application/shell/runtime.js"
import type { ExecutableTool, ToolMetadata } from "../../domain/agent-types.js"
import { BROWSE_WEB_ACTION_VALUES, BrowseWebAction } from "../../domain/enums/browse-web.js"
import {
    handleClick,
    handleClose,
    handleFrame,
    handleIntercept,
    handleNavigate,
    handleRead,
    handleScroll,
    handleTabs,
    handleType,
    handleUpload,
} from "./actions.js"
import { getKillSignal, getSession } from "./session.js"

// Re-export public helpers
export { closeAllBrowserSessions } from "./session.js"
export type { BrowserSession } from "./session.js"

// ── Constants (hoisted so const-tool initializers don't trip TDZ) ─

const BROWSE_WEB_DESCRIPTION =
  "Interactive web browsing with a persistent browser session. " +
  "Actions: navigate (open URL), click (CSS selector or button text), " +
  "type (into input field), scroll (up/down), read (get current page text), close (end session), " +
  "upload (set <input type=file>), tabs (list/switch/new/close), frame (list/switch/top), intercept (block URL substrings). " +
  "Selector prefixes: 'css:' (default), 'xpath:', 'text:', 'role:button', 'role:button[name=Submit]'. " +
  "Returns page text after each action. Use for complex web interactions " +
  "(forms, cookie consent, multi-page flows). For simple reads, prefer fetch_url. " +
  "Set visible=true on navigate to open a browser window the user can see — " +
  "use with ask_user when the user needs to complete a step (CAPTCHA, payment, 2FA)."

const BROWSE_WEB_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...BROWSE_WEB_ACTION_VALUES],
      description: "The browser action to perform.",
    },
    url: {
      type: "string",
      description: "URL to navigate to (for 'navigate' and 'tabs' sub=new).",
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
        "Selector for the target element. Plain string is treated as CSS; prefix with 'xpath:', 'text:', or 'role:' for other strategies. " +
        "If the primary selector isn't found for a click, text content matching is attempted as fallback.",
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
    file_path: {
      type: "string",
      description:
        "For 'upload' action: path to the file to upload, relative to the workspace root. " +
        "Use the import_attachment tool first to bring user files into the workspace.",
    },
    sub: {
      type: "string",
      description:
        "Sub-action for 'tabs' (list|switch|new|close), 'frame' (list|switch|top), or 'intercept' (set|clear).",
    },
    index: {
      type: "number",
      description: "Tab or frame index (for 'tabs' switch/close, 'frame' switch).",
    },
    patterns: {
      type: "array",
      items: { type: "string" },
      description:
        "For 'intercept' sub=set: URL substrings to BLOCK (e.g. 'doubleclick.net', '.png'). " +
        "Replaces any prior list. Empty to allow everything.",
    },
  },
  required: ["action"],
} as const

export const browseWebToolMetadata: ToolMetadata = {
  name: "browse_web",
  description: BROWSE_WEB_DESCRIPTION,
  parameters: BROWSE_WEB_PARAMETERS,
}

export const browseWebTool = browseWebToolMetadata

/**
 * Factory variant bound to a host — the only supported construction path.
 * Threads the host through to session.ts so `host.browser.runtime.activeSessions`,
 * `host.browser.runtime.idCounter`, and `host.browser.providers.contextReader` are sourced
 * from the explicit AgentHost rather than any ambient runtime state.
 */
export function createBrowseWebTool(host: AgentHost, run?: RunContext): ExecutableTool {
  return {
    ...browseWebToolMetadata,
    async execute(args) {
      return runBrowseWeb(args, host, run)
    },
  }
}

// ── Shared body ──────────────────────────────────────────────────

async function runBrowseWeb(args: Record<string, unknown>, host: AgentHost, run?: RunContext): Promise<string> {
    const action = String(args.action)
    const sessionId = args.session_id ? String(args.session_id) : undefined
    const maxLength = Number(args.max_length ?? 10000)

    // If kill signal already fired before we start, bail immediately
    if (getKillSignal(run?.signal)?.aborted) return "Error: Tool execution cancelled"

    if (action === BrowseWebAction.Navigate) {
      return handleNavigate({
        host,
        url: String(args.url ?? ""),
        visible: Boolean(args.visible),
        sessionId,
        maxLength,
        signal: run?.signal ?? null,
      })
    }

    // All remaining actions require a session
    if (!sessionId) return "Error: 'session_id' is required. Use 'navigate' first to start a session."
    const s = getSession(host, sessionId)
    if (typeof s === "string") return s
    const session = s

    switch (action) {
      case BrowseWebAction.Click:
        return handleClick(session, sessionId, String(args.selector ?? ""), maxLength, run?.signal ?? null)
      case BrowseWebAction.Type:
        return handleType(session, sessionId, String(args.selector ?? ""), String(args.text ?? ""), maxLength, run?.signal ?? null)
      case BrowseWebAction.Scroll:
        return handleScroll(session, sessionId, String(args.direction ?? "down"), maxLength)
      case BrowseWebAction.Read:
        return handleRead(session, sessionId, maxLength)
      case BrowseWebAction.Close:
        return handleClose(host, session, sessionId)
      case BrowseWebAction.Upload:
        return handleUpload(
          session,
          sessionId,
          String(args.selector ?? ""),
          String(args.file_path ?? ""),
          host.workspaceRoot,
          maxLength,
        )
      case BrowseWebAction.Tabs:
        return handleTabs(
          session,
          sessionId,
          String(args.sub ?? "list"),
          args.index === undefined ? undefined : Number(args.index),
          args.url === undefined ? undefined : String(args.url),
          maxLength,
        )
      case BrowseWebAction.Frame:
        return handleFrame(
          session,
          sessionId,
          String(args.sub ?? "list"),
          args.index === undefined ? undefined : Number(args.index),
        )
      case BrowseWebAction.Intercept:
        return handleIntercept(
          session,
          sessionId,
          String(args.sub ?? "set"),
          Array.isArray(args.patterns) ? args.patterns.map(String) : [],
        )
      default:
        return `Error: Unknown action "${action}". Use: navigate, click, type, scroll, read, close, upload, tabs, frame, intercept.`
    }
}
