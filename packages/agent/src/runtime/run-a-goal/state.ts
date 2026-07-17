/**
 * Mutable loop state for one run.
 *
 * What: counters, circuit breakers, stuck detection — owned by runtime.
 * Why: core must stay pure; state lives here.
 * Next: created once in runGoal; passed into each step.
 */

export { createAgentLoopState, type AgentLoopState } from "../loop.js"
