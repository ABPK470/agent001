# Sync definitions (legacy path note)

This directory previously held a checked-in **published bundle file**. That is no longer runtime authority.

## Runtime authority (current)

| Layer | Where | Role |
|-------|--------|------|
| **Catalog** | SQLite | Editable pieces: entities, flows, actions, sources, environments, strategies, run pointers |
| **SyncDefinitions** | SQLite (`sync_definitions` + `sync_publish_meta`) | Live process contracts after **Publish** |
| **Preview** | Reads SyncDefinitions from SQLite | Same JSON shape execute snapshots into the plan |
| **Export** | Download on demand | Optional zip/JSON for git/backup — never written by Publish into the tree |

## Publish

Entity Registry → ⚙ → **Publish** assembles the catalog tip into live SyncDefinition rows. It does **not** write `published/definitions.bundle.json`.

A leftover file under `published/` may still exist for one-time upgrade import into SQLite on boot; it is not used once SQLite has publish meta.

## Seeds (git)

Boot seeds live under [`deploy/sync/`](../deploy/sync/). See [ARTIFACT-FORMATS.md](../deploy/sync/ARTIFACT-FORMATS.md) and [SYNC-MODEL.md](../packages/sync/SYNC-MODEL.md).
