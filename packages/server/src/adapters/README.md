# adapters

Concrete implementations of contracts used or owned by `@mia/server`.

This is the shell-heavy side of the package.

Subfolders split adapters by concern:

- `persistence/` for durable-state adapters
- `browser/` for browser/session adapters
- `auth/` for auth/session adapters
- `llm/` for model adapters
- `sandbox/` for isolated execution adapters