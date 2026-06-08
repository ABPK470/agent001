import type { PolicyContext, RunContext, RunMemoryWriter, SyncOpContext, ToolTraceContext } from "./host.js"

export interface MakeRunContextOptions {
  signal?: AbortSignal | null
  memory?: RunMemoryWriter | null
  trace?: ToolTraceContext | null
  policy?: PolicyContext | null
  syncOp?: SyncOpContext | null
  mssqlProfileCalls?: Iterable<string>
}

export function makeRunContext(options: MakeRunContextOptions = {}): RunContext {
  return {
    signal: options.signal ?? null,
    memory: options.memory ?? null,
    trace: options.trace ?? null,
    policy: options.policy ?? null,
    syncOp: options.syncOp ?? null,
    mssqlProfileCalls: new Set(options.mssqlProfileCalls ?? [])
  }
}
