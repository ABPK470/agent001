# runtime

Stateful sync drivers: preview/execute, plan store, catalog drift, artifact and
environment loaders, MSSQL query runners for the diff engine.

**SyncPlan** = persisted preview envelope.  
**SyncPlanTable.changeSet** = per-table execute instructions. Execute reads only `changeSet`.

See [SYNC-PREVIEW-EXECUTE.md](../../SYNC-PREVIEW-EXECUTE.md). Pure decisions stay in `core/` / `domain/`.
