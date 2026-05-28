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

- runtime registry projection fallbacks

Those artifacts are migration inputs, not the source to edit.

## Current Workflow

1. Edit one or more files in `sync-definitions/entities/`.
2. Run:

```bash
npm run sync:definitions:compile -- --write
```

3. The compiler validates the repo-authored definitions and regenerates:

- `sync-definitions/published/definitions.bundle.json`

`sync-definitions/published/definitions.bundle.json` is the published runtime
definition bundle.

## Draft Authoring Workflow

When an entity starts in the Entity Registry or in exported YAML, scaffold the
repo-owned definition instead of hand-rebuilding it:

```bash
npm run sync:definitions:scaffold -- \
	--input path/to/entities.yaml \
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
	--input path/to/entities.yaml \
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

The separate Entity Registry workspace can export the same draft shape directly
from stored entity definitions:

- `GET /api/entity-registry/entities/:id/scaffold-sync-definition`

Use the API route when the draft source is already in the registry DB. Use the
scaffold script when the starting point is YAML on disk.

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
- preview/execute runtime consumes the published definition bundle

Some helper/API surfaces may still read the compatibility recipe artifact during
the migration, but the backend preview/execute path no longer does.