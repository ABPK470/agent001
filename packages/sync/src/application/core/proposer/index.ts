/**
 * Proposer subsystem — agent-side public surface.
 *
 * Anything exported here is safe to consume from packages/server. Keep
 * runtime IO out of this module — it should re-export pure functions
 * and types only.
 */

export * from "./annotate.js"
export * from "./annotation-schema.js"
export * from "./canonical.js"
export * from "./pass.js"
export * from "./rank.js"
export * from "./types.js"

