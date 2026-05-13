/**
 * Loop cluster — public API.
 *
 * Outside this folder, import from `./loop/index.js` only.
 * Files inside `loop/` are private implementation details.
 *
 * Note: `agent.ts` (the public Agent class) is the primary consumer and
 * orchestrates the loop. Other consumers (planner-routing, agent-helpers)
 * should also go through this index.
 */

export * from "./state.js"
export * from "./completion-guards.js"
export * from "./post-round.js"
export * from "./system-prompt.js"
export * from "./tool-execution.js"

