/**
 * Run-level lifecycle persistence sink helpers.
 */

import type { SyncRunHost } from "../../ports/host.js"
import type { SyncRunSink } from "../../ports/run-sink.js"

export function configureSyncRunSink(host: SyncRunHost, sink: SyncRunSink): void {
  host.sync.runSink = sink
}

export function getSyncRunSink(host: SyncRunHost): SyncRunSink {
  return host.sync.runSink
}