/**
 * Governance layer — the agent runs ON the engine.
 *
 * Provides:
 *   - `governTool`: wrap a tool with audit, policy enforcement, and step-recording.
 *   - Re-exports of engine services and result types used by the server orchestrator.
 *
 * The CLI-mode `runGoverned` and `printGovernanceReport` were removed when the
 * standalone CLI was retired; the server orchestrator drives runs end-to-end
 * via `governTool` directly.
 */

export { governTool, type GovernToolOptions } from "./govern-tool.js"
export {
  createEngineServices,
  createToolStep,
  type EngineServices,
  type GovernedResult,
  type RunState
} from "./types.js"
