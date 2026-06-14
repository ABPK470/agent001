# Sync model — terminology

One-page glossary for how sync concepts relate in code.

## Authority chain

```
Entity registry (DB)     — table structure, scopes, SCD2 refs
        +
Sync admin config (DB)   — flow preset, execution steps, bindings
        ↓ publish
Published sync definition — frozen bundle (definitions.bundle.json)
        ↓ definitionToSyncRecipe()
SyncRecipe (runtime)     — diff-engine projection
        ↓ preview / execute
SyncPlan → apply on target MSSQL
```

## Terms

| Term | Meaning |
|------|---------|
| **Entity registry** | Versioned DB records (`EntityDefinition`): root table, dependent tables, scope per table, policies. |
| **Sync definition** | Full operational contract: structure + governance + bindings + execution flow. |
| **Authored sync definition** | JSON shape before publish (`AuthoredSyncDefinition`). Repo drafts under `deploy/sync/artifacts/entities/`. |
| **Published sync definition** | Authored shape + `publishedAt` / `publishedVersion`. **Runtime authority** for preview/execute. |
| **SyncRecipe** | Runtime projection of a published definition for the diff engine. Legacy name: "recipe". |
| **Flow template** | Named starter step list (`contract`, `dataset`, `metadata-only`, …). Seeds DB config only. |

## Compilers (all use `projectTablePredicate`)

| Function | When | Output |
|----------|------|--------|
| `scaffoldSyncDefinition` | Export draft from entity registry | `AuthoredSyncDefinition` |
| `composePublishedSyncDefinition` | Publish from DB | `PublishedSyncDefinition` |
| `projectRecipe` | Registry + SCD2 strategy (tests/tooling) | `SyncRecipe` + effective SCD2 |
| `definitionToSyncRecipe` | Runtime load | `SyncRecipe` |

## What "recipe" means today

- **Not** a separate authoring artifact.
- **Is** the diff-engine view of a published definition: tables, predicates, execution order, archive tables.

See [SYNC-MECHANICS.md](./SYNC-MECHANICS.md) for hash-based comparison details.
