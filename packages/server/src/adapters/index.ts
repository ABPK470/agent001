/**
 * Concrete adapters for `@mia/agent` and `@mia/sync` ports.
 * Boot wires these; api/ surfaces consume the resulting host/context.
 */
export { bootHostDepsToConfigureAgentOptions } from "./agent/boot-host-deps.js"
export { configureSandbox, type SandboxRuntime } from "./agent/shell.js"
export {
  createBridgeEventSink,
  createSyncEventSink,
  createSyncRunSink,
} from "./sync/sinks.js"
