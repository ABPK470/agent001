/**
 * Run-level lifecycle persistence sink helpers.
 */

import type { AgentHost } from "../../ports/host.js"
import type { SyncRunSink } from "../../ports/run-sink.js"

export function configureSyncRunSink(host: AgentHost, sink: SyncRunSink): void {
  host.sync.runSink = sink
}

export function getSyncRunSink(host: AgentHost): SyncRunSink {
  return host.sync.runSink
}