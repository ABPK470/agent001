/**
 * Selector resolver — turns the agent's selector string into a Playwright
 * Locator. Prefix syntax lets the agent target elements that pure CSS
 * cannot reach (xpath axes, accessible roles, visible text):
 *
 *   "css:..."         → CSS (default when no prefix)
 *   "xpath:..."       → XPath
 *   "text:..."        → visible text (substring, case-insensitive by default)
 *   "role:button"     → accessible role
 *   "role:button[name=Submit]"  → role + accessible name
 *
 * The default branch (no recognised prefix) treats the whole string as a
 * CSS selector to preserve backwards compatibility with the original
 * `browse_web` schema.
 *
 * @module
 */

type LocatorTarget = import("playwright").Page | import("playwright").Frame

const ROLE_NAME_RE = /^([a-zA-Z]+)(?:\[name=(.+)\])?$/

export function resolveLocator(target: LocatorTarget, selector: string): import("playwright").Locator {
  const trimmed = selector.trim()
  if (trimmed.startsWith("xpath:")) {
    return target.locator(`xpath=${trimmed.slice("xpath:".length).trim()}`)
  }
  if (trimmed.startsWith("text:")) {
    return target.getByText(trimmed.slice("text:".length).trim())
  }
  if (trimmed.startsWith("role:")) {
    const body = trimmed.slice("role:".length).trim()
    const m = ROLE_NAME_RE.exec(body)
    if (m) {
      const role = m[1]! as Parameters<LocatorTarget["getByRole"]>[0]
      const name = m[2]
      return name === undefined ? target.getByRole(role) : target.getByRole(role, { name })
    }
    // Fall through to CSS if the role expression is malformed.
  }
  if (trimmed.startsWith("css:")) {
    return target.locator(trimmed.slice("css:".length).trim())
  }
  return target.locator(trimmed)
}
