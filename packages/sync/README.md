# `@mia/sync`

Execution core for ABI sync: preview, execute, diff, entity registry,
environments, governance, and agent-facing sync tools.

Same doctrine as `@mia/agent`: **runtime owns I/O; core is pure; domain is
vocabulary.** HTTP and SQLite stay on `@mia/server` (`api/sync`, `infra/`).

## Layout

```text
src/
├── domain/      # types, enums, pure registry/compile helpers
├── core/        # pure decisions (proposer, …)
├── runtime/     # preview/execute drivers, plan store, catalog drift, artifacts
├── ports/       # contracts only (*Host, *Sink)
├── tools/       # agent-facing tool factories
├── adapters/    # MSSQL pool helpers (thin)
├── internal/    # package helpers
└── test-support/
```

## Documentation

| Doc | Contents |
|-----|----------|
| [SYNC-MECHANICS.md](./SYNC-MECHANICS.md) | Hash diff model, changeSet, mental model |
| [SYNC-PREVIEW-EXECUTE.md](./SYNC-PREVIEW-EXECUTE.md) | Plan build, execute transaction |
| [SYNC-MODEL.md](./SYNC-MODEL.md) | Terminology and authority chain |
| [docs/doctrine.md](../../docs/doctrine.md) | Monorepo + package layer rules |

Import only from `@mia/sync`. Enforce with `npm run lint:arch`.

## Tests / CI quarantine

| Command | Scope |
| --- | --- |
| `npm run test:dialects` | **CI matrix gate** — `WarehouseDialect` adapters, eligibility, ports |
| `npm test` | Full package suite (includes orchestrator paths with known pre-existing failures) |

RDBMS CI ([`.github/workflows/rdbms-matrix.yml`](../../.github/workflows/rdbms-matrix.yml))
runs `test:dialects` only. Do not treat a red full `npm test` as blocking the
dialect matrix until those orchestrator failures are tracked and fixed
separately. Live Postgres service jobs run when sync/platform/sql-kit paths
change (or on `workflow_dispatch`).
