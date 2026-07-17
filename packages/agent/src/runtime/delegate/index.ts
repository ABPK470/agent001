/**
 * Delegation cluster — public API.
 *
 * Outside this folder, import from `./delegation/index.js` only.
 * Files inside `delegation/` are private implementation details.
 *
 * Note: `normalizeArtifactPath` exists in BOTH this cluster and
 * `loop/tool-execution` with different semantics. The delegation copy is
 * intentionally NOT re-exported here to avoid a barrel collision; it
 * remains importable directly inside the delegation cluster.
 */

export * from "../../core/delegate-decision/index.js"
export * from "./learning.js"
export * from "./validation/index.js"
export * from "./correct-validation.js"
export * from "./escalation.js"

// delegation-validation-patterns.ts re-exports ALL constants and helpers EXCEPT
// `normalizeArtifactPath` (collides with loop/tool-execution).
export * from "./validation-patterns/constants.js"
export { getToolCallPathArg } from "./validation-patterns/index.js"
