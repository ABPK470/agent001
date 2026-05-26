/**
 * Additive door for the new `application/` cluster.
 *
 * This split makes the functional-core vs shell distinction visible from the
 * tree before callers open a file.
 */

export * from "./core/index.js"
export * from "./shell/index.js"
