import type { PolicyContext, RunContext, RunMemoryWriter, SyncOpContext, ToolTraceContext } from "./host.js"
import { verifiedTableKey } from "../../domain/mssql/verified-table-key.js"

export interface MakeRunContextOptions {
  signal?: AbortSignal | null
  memory?: RunMemoryWriter | null
  trace?: ToolTraceContext | null
  policy?: PolicyContext | null
  syncOp?: SyncOpContext | null
  mssqlProfileCalls?: Iterable<string>
  mssqlVerifiedTables?: Iterable<string>
}

export function makeRunContext(options: MakeRunContextOptions = {}): RunContext {
  const verified = new Set<string>()
  for (const q of options.mssqlVerifiedTables ?? []) verified.add(verifiedTableKey(q))
  for (const q of options.mssqlProfileCalls ?? []) verified.add(verifiedTableKey(q))
  return {
    signal: options.signal ?? null,
    memory: options.memory ?? null,
    trace: options.trace ?? null,
    policy: options.policy ?? null,
    syncOp: options.syncOp ?? null,
    mssqlProfileCalls: new Set([...(options.mssqlProfileCalls ?? [])].map(verifiedTableKey)),
    mssqlVerifiedTables: verified
  }
}
