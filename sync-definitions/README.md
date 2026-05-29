# Sync Definitions

This directory holds repo draft artifacts and the published runtime bundle for
sync definitions.

## Runtime Authority

- `sync-definitions/published/definitions.bundle.json`

Preview/execute consumes the published bundle, not the draft files directly.

## Authoring Authority

The current authoring source-of-truth is split:

- Entity Registry DB records own the entity structure
- Sync Admin DB config owns the selected flow preset, edited execution steps,
	bindings, and ownership metadata

Once an operator edits and saves execution steps in the UI, the DB state is the
authoritative state for the application. The code/file-based templates are only
used to create an initial starting point.

## Repo Draft Artifacts

- `deploy/sync/entities/*.json`

These files are review/export artifacts in the repo. They can still be used for
draft authoring, diff review, or external editing, but they are not the live
runtime source-of-truth once a definition/config has been edited in the DB.

## What Is Not Authoritative

- runtime registry projection fallbacks

Those artifacts are migration inputs, not the source to edit.

## Current Runtime Lifecycle

1. `deploy/sync/flow-templates.json` provides the initial flow template for a
	named template id such as `contract` or `dataset`.
2. When a sync definition config row is first created, that template seeds the
	initial `execution_steps_json` in the DB.
3. Operators can then change the steps in the UI.
4. Those edited steps are saved back to the DB and become the real application
	source-of-truth.
5. Publish reads the DB-backed entity/config state and writes the published
	bundle.
6. Preview/execute reads the published bundle.

## Repo Draft Workflow

1. Edit one or more files in `deploy/sync/entities/`.
2. Run:

```bash
npm run sync:definitions:compile -- --write
```

3. The compiler validates the repo-authored definitions and regenerates:

- `sync-definitions/published/definitions.bundle.json`

`sync-definitions/published/definitions.bundle.json` is the published runtime
definition bundle.

## Draft Export / Scaffold Workflow

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
- applies an explicit execution-flow template for known entity types
- fills the required governance and binding blocks with reviewable defaults
- emits the full repo-authored JSON definition shape to stdout

To write directly to a repo definition file:

```bash
npm run sync:definitions:scaffold -- \
	--input path/to/entities.yaml \
	--entity contract \
	--write --force
```

For brand-new entities that do not match an existing flow template, use the
metadata-only starter and then extend the execution flow deliberately:

```bash
npm run sync:definitions:scaffold -- \
	--input path/to/entity.yaml \
	--flow-template metadata-only
```

This keeps the split explicit:

- Entity Registry is the DB-backed authoring surface.
- flow templates only supply the initial step list.
- YAML remains an import/export draft format.
- `deploy/sync/entities/*.json` is a repo draft / review artifact.
- `sync-definitions/published/definitions.bundle.json` remains the runtime bundle consumed by preview/execute.

The separate Entity Registry workspace can export the same draft shape directly
from stored entity definitions:

- `GET /api/entity-registry/entities/:id/scaffold-sync-definition`

Use the API route when the draft source is already in the registry DB. Use the
CLI when the starting point is YAML on disk.

## Validation Rules

The compiler currently enforces:

- `schemaVersion === 1`
- unique entity ids
- non-empty metadata tables
- execution and reverse order cover the same table set
- exactly one `metadataSync` flow step per entity
- positive governance risk multiplier

Warnings are emitted for unverified tables so review work remains visible.

## Template Boundary

The predefined flow templates are starter templates, not the long-term runtime
authority. They exist so the system can answer questions like:

- if a new `contract` sync definition config is created, what step list should
	it start with?
- if a repo draft is scaffolded for `dataset`, what default execution flow
	should be inserted before review?

If the platform later moves these templates into deployment config or DB-backed
template records, this README should still remain true about the authority
boundary:

- template catalog seeds initial state
- DB-backed config becomes the application source-of-truth after editing
- publish writes the runtime bundle
- preview/execute consumes the runtime bundle