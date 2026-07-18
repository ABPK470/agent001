/** @deprecated Use ./sync-value-sources.js — thin re-export during vocabulary rename. */
export {
  deleteSyncValueSource as deleteSyncRunBindingSource,
  listSyncValueSources as listSyncRunBindingSources,
  mapValueSourceDefinition as mapCustomValueSourceDefinition,
  saveSyncValueSource as saveSyncRunBindingSource,
  type DbSyncValueSource as DbSyncRunBindingSource,
} from "./sync-value-sources.js"
