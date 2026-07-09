# shell

Stateful shell for sync application flow.

**SyncPlan** = persisted preview envelope (entity, environments, execution contract, tables, warnings).  
**SyncPlanTable.changeSet** = per-table execute instructions (insert / update / delete PK lists). Execute reads only `changeSet`.

See [SYNC-PREVIEW-EXECUTE.md](../../SYNC-PREVIEW-EXECUTE.md) §4.

This folder is the target home for preview/execute runners, coordinators, and
other stateful orchestration surfaces.
