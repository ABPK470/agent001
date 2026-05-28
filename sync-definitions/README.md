# Sync Definitions

This directory is the authoritative repo-authored source for sync entity
definitions introduced in phase 0-2 of the unified sync redesign.

## What Is Authoritative

- `sync-definitions/entities/*.json`

These files define:

- entity identity and root scope
- metadata table scope and ordering
- execution flow steps
- governance references
- runtime binding references
- provenance of the definition itself

## What Is Not Authoritative

- `deploy/mssql/sync-recipes.json`
- `deploy/mssql/entities/_all.yaml`
- runtime registry projection fallbacks

Those artifacts may still exist for compatibility or migration, but they are not
the source to edit.

## Current Workflow

1. Edit one or more files in `sync-definitions/entities/`.
2. Run:

```bash
npm run sync:definitions:compile -- --write
```

3. The compiler validates the repo-authored definitions and regenerates:

- `sync-definitions/published/definitions.bundle.json`
- `deploy/mssql/sync-recipes.json`

`sync-definitions/published/definitions.bundle.json` is the published runtime
definition bundle.

`deploy/mssql/sync-recipes.json` remains a compatibility artifact for surfaces
that still consume the legacy recipe shape.

## Draft Authoring Workflow

When an entity starts in the Entity Registry or in exported YAML, scaffold the
repo-owned definition instead of hand-rebuilding it:

```bash
npm run sync:definitions:scaffold -- \
	--input deploy/mssql/entities/_all.yaml \
	--entity contract
```

This command:

- reads an entity-registry YAML document
- projects table scope into the repo definition `metadata.tables[*].predicate`
- applies an explicit execution-flow preset for known entity types
- fills the required governance and binding blocks with reviewable defaults
- emits the full repo-authored JSON definition shape to stdout

To write directly to a repo definition file:

```bash
npm run sync:definitions:scaffold -- \
	--input deploy/mssql/entities/_all.yaml \
	--entity contract \
	--write --force
```

For brand-new entities that do not match an existing flow preset, use the
metadata-only starter and then extend the execution flow deliberately:

```bash
npm run sync:definitions:scaffold -- \
	--input path/to/entity.yaml \
	--flow-preset metadata-only
```

This keeps the authoring split explicit:

- Entity Registry / YAML is a draft input surface.
- `sync-definitions/entities/*.json` remains the only authoritative runtime
	source after review and compile/publish.

The separate Entity Registry workspace can now export the same draft shape
directly from stored entity definitions:

- `POST /api/entity-registry/entities/:id/export-sync-definition`
- `GET /api/entity-registry/sync-definition-status`

Use the export route when the source of truth for the draft is already in the
registry DB. Use the scaffold script when the starting point is YAML on disk.

The status route makes the remaining migration debt explicit:

- which repo definitions still carry `legacy-migration` provenance
- which authored definitions still contain unverified tables
- which compatibility layers remain in tree but are no longer runtime authority

## Bootstrap

To re-seed the repo definitions from the legacy recipe bundle during migration:

```bash
npm run sync:definitions:compile -- --bootstrap-from-bundle --write
```

Use this only as a migration/bootstrap helper. Do not treat the legacy recipe
bundle as the long-term source of truth.

## Validation Rules

The compiler currently enforces:

- `schemaVersion === 1`
- unique entity ids
- non-empty metadata tables
- execution and reverse order cover the same table set
- exactly one `metadataSync` flow step per entity
- positive governance risk multiplier

Warnings are emitted for unverified tables so review work remains visible.

## Current Boundary

What is complete now is the source-of-truth and runtime boundary:

- humans edit repo definitions
- compiler validates them
- published definition bundle is generated
- compatibility recipe artifact is generated
- preview/execute runtime consumes the published definition bundle

Some helper/API surfaces may still read the compatibility recipe artifact during
the migration, but the backend preview/execute path no longer does.