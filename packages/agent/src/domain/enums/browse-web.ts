/**
 * Browse-web action enum — single source of truth for the
 * `browse_web` tool's action discriminant. Promoted from the inline
 * JSON-schema string array + switch-arm literals so the schema, the
 * dispatcher, and downstream consumers can never drift apart.
 *
 * @module
 */

export const BrowseWebAction = {
  Navigate: "navigate",
  Click: "click",
  Type: "type",
  Scroll: "scroll",
  Read: "read",
  Close: "close",
  Upload: "upload",
  Tabs: "tabs",
  Frame: "frame",
  Intercept: "intercept"
} as const

export type BrowseWebAction = (typeof BrowseWebAction)[keyof typeof BrowseWebAction]

export const BROWSE_WEB_ACTION_VALUES: ReadonlyArray<BrowseWebAction> = Object.values(BrowseWebAction)

export const isBrowseWebAction = (value: unknown): value is BrowseWebAction =>
  typeof value === "string" && (BROWSE_WEB_ACTION_VALUES as readonly string[]).includes(value)
