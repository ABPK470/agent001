# adapters

Concrete implementations of contracts used or owned by `@mia/server`.

This is the shell-heavy side of the package.

Subfolders split adapters by concern:

- `persistence/` for durable-state adapters
- `llm/` for model adapters
- `effects/` for effect-log capture and rollback helpers
- `sync/` for server-local sync glue

`auth/`, `browser/`, `llm/`, and `sandbox/` now live as canonical top-level
implementation folders under `src/`. Do not recreate mirror adapter folders
that only re-export those implementations.
