/**
 * Stateful-shell compatibility barrel for the new `application/shell` split.
 *
 * This barrel stays curated so it does not flatten overlapping symbols from
 * lower-level shell entrypoints into one namespace.
 */

export * from "./agent.js"
export * from "./delegation.js"
export * from "./runtime.js"
export * from "./tenant-config.js"

