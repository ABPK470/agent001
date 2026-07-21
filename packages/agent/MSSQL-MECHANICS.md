# MSSQL mechanics

How `@mia/agent` connects to SQL Server, builds a mental model of a vast database, and traverses it safely for analysis (and how that differs from sync).

**Scope:** Microsoft SQL Server only. One connection pool per named environment (`default`, `uat`, `prod`, …). Policy / env access governs DML on real tables; `#temp` staging is allowed inside `query_mssql` batches. `export_query_to_file` is tool-level read-only (SELECT/WITH/#temp). Sync (`@mia/sync`) reuses the same pool machinery but follows its own scoped diff/execute path — see [packages/sync/SYNC-MECHANICS.md](../sync/SYNC-MECHANICS.md) and [packages/sync/SYNC-PREVIEW-EXECUTE.md](../sync/SYNC-PREVIEW-EXECUTE.md).

---

## 1. What “knowing the database” means

The agent does **not** load every row or memorize every table name up front. It has three layers:

| Layer | When built | What it contains |
|---|---|---|
| **Connection registry** | Server boot | Host, database, credentials, read/write flag, optional knowledge file |
| **Schema catalog** | Boot (+ disk cache) | All tables/views, columns, PKs, FK graph, implicit join edges, row counts, `sys.*` index |
| **Live probes** | Per tool call | Exact column lists, profiling stats, view SQL, FK paths, query results |

**Curated knowledge** (`deploy/mssql/mymi-knowledge.md` or per-connection `knowledgePath`) adds business context: what `core`, `publish`, `fact`, `dim` mean, naming conventions (`pkClient`, not `clientId`), and the recommended tool order. That text is injected into the system prompt — it is not queried from SQL at runtime.

---

## 2. Step 0 — boot: wire the server

At startup (`setupMssql` → `setMssqlConfigs`):

1. Read `MSSQL_DATABASES` (multi-env JSON) or `MSSQL_HOST` (single `default` connection).
2. Optionally load a **knowledge file** per connection (`MSSQL_KNOWLEDGE_FILE` / `knowledgePath`).
3. Register named pools on `host.mssql.databases` (lazy connect on first query).

Then `buildLlmAndCatalog` runs for each connection:

1. Try **disk cache** (`CATALOG_CACHE_PATH`, default `~/.mia/catalog-cache.json`, per-connection suffix when multi-env).
2. If cache missing or older than `CATALOG_MAX_AGE_HOURS` (default 168h), **introspect live MSSQL** and rewrite cache.

Console logs: schemas / tables / views / columns / FK counts per connection.

---

## 3. Step 1 — build the schema catalog

`buildCatalog` → `CatalogGraph.build` → `loadCatalogFromDb` issues a small fixed set of queries:

| Step | Source | Result |
|---|---|---|
| Objects | `sys.tables` / `sys.views` + partition stats | Every table/view, approximate `row_count` |
| Columns | `sys.columns` + types + PK flags | Full column list per object |
| FKs | `sys.foreign_keys` | Directed FK edges + bidirectional adjacency |
| Indexes | Name + column inverted indexes | Instant keyword search |
| Implicit joins | Heuristic on shared column names + compatible types | Edges where no formal FK exists |
| View deps | `sys.sql_expression_dependencies` | Which physical tables sit under a view |
| View SQL | `sys.sql_modules` | `CREATE VIEW` text attached to catalog entries |
| Sys catalog | `sys.*` DMVs / catalog views | Searchable index for engine internals |

The in-memory graph (`host.catalog.instances`) is also serialized to JSON (version 7). **`search_catalog` reads this graph only** — no SQL on the hot path.

`search_catalog(refresh=true)` forces a rebuild from live DB and updates cache.

---

## 4. Step 2 — inject context into the agent

Each run’s system prompt (`buildToolContext` / `buildRunPrompt`) adds:

- **Which servers** exist (policy/env access governs writes).
- **Default connection** name in multi-env mode (so `connection=` vs `database=` is not confused).
- **Knowledge file body** (full or header-only, depending on goal classification).
- **Catalog prompt summary** — compact stats (schema count, largest tables, etc.) from `getCatalogPromptSummary`.
- **Worked examples** derived from the live catalog (wide-union view name, schema samples, dimension join hints).

The agent also gets **tool descriptions** that encode discipline: catalog before SQL, schema-qualified names, no `SELECT *` on wide tables.

---

## 5. Step 3 — discovery tools (traverse before query)

Intended order for any analytical goal on a large database:

### 5a. `search_catalog` — primary navigation (instant)

Pre-built graph search. Modes:

| Parameter | Use |
|---|---|
| `search='keyword'` | Find tables/views/columns by name (+ `sys=` DMV search) |
| `table='schema.Table'` | Full detail: columns, types, PK, FKs, row count |
| `column='name'` | Every table with that column |
| `joins='schema.Table'` | FK + implicit edges for join planning |
| `path=['A','B']` | Shortest FK paths between two tables |
| `stats=true` | Catalog footprint |
| `sys='keyword'` | Locate DMVs / catalog views for engine questions |
| `refresh=true` | Rebuild from live DB |

Always start here. Row counts and centrality in results help pick the right object among hundreds of similarly named tables.

### 5b. `explore_mssql_schema` — live column truth (SQL)

Hits `INFORMATION_SCHEMA` / `sys.columns` when the catalog is stale or you need live confirmation.

- `schema='agent'` — list objects in a schema.
- `table='core.Dataset'` — exact columns + types for one object.
- `search='Revenue'` — pattern search across schemas.

**Mandatory before `query_mssql`** when column names are not already verified. Results can be served from **tool-knowledge cache** (same column fingerprint as `profile_data`).

### 5c. `discover_relationships` — FK graph traversal (SQL)

Relationship-first exploration beyond the catalog snapshot:

- `table='schema.Table'` — all incoming/outgoing FKs.
- `between=['A','B']` — up to 5 shortest FK join paths.
- `schema='core'` — FK map for a schema.
- `column='contractId'` — implicit join candidates.

Use before multi-table joins when `search_catalog(joins=…)` is not enough.

### 5d. `inspect_definition` — view/proc source (SQL)

Reads `sys.sql_modules` and dependency DMVs:

- View/proc **T-SQL body**, duplicate-join flags.
- `depends_on` — dependency tree.
- `slow_queries`, `missing_indexes`, `index_usage` — operational DMVs.
- Bulk `scan_duplicates` across many objects.

Use when the question is *why* a view is slow or what it actually selects.

### 5e. `profile_data` — what is inside the rows (SQL)

| Mode | Behavior |
|---|---|
| `fast` (default) | Metadata only: row count, column list, keys — safe on any size |
| `deep` | NULL rates, distinct counts, min/max, top values — **refused on large / wide union views** |

Call before aggregating unknown columns (SUM vs AVG) or before heavy joins to large dimensions. Successful profiles are cached in **tool-knowledge** keyed by catalog column fingerprint.

---

## 6. Step 4 — execute analysis SQL

### `query_mssql`

Runs T-SQL against the chosen `connection=` pool.

- Validated **before** execution (`validateQueryDetailed`): blocks unfiltered scans on huge objects, dangerous writes on real tables, `##temp`, etc.
- Allows `#temp` micro-ETL in a **single batch** for slicing billion-row joins.
- Results formatted as plain text; **truncated** (~200 rows / ~50KB) — not for export.
- Errors enriched with hints (`explore_mssql_schema`, `search_catalog`, doctrine lessons written to run memory).

Optional `database=` runs `USE [catalog]` on the **same server** — not an environment switch.

### `export_query_to_file`

Streams full result sets to disk when the user wants a file — avoids copying truncated `query_mssql` output into `write_file`.

---

## 7. Step 5 — caches and freshness

| Cache | Keyed by | Invalidates when |
|---|---|---|
| Catalog disk JSON | Connection + file mtime | `refresh=true`, max age, schema version bump |
| Tool-knowledge (`tool_knowledge_cache` table) | Tool + object + mode + column fingerprint | Column set/type change, catalog graph size change |
| `explore_mssql_schema` | Table qname + columns | Same fingerprint as profiler |
| `discover_relationships` | Table / path / schema / column mode | Catalog topology change |

Pure **data** changes do not invalidate relationship or column-layout caches. **DDL** does.

Run memory (`note` / episodic) can store lessons (e.g. “this column is a snapshot, don’t SUM it”) with optional `schemaFingerprint` from `getCatalogSchemaFingerprint`.

---

## 8. Recommended traversal flow (vast database)

Typical analytical path:

```
1. search_catalog(search='…')     → pick candidate tables (row counts, schemas)
2. search_catalog(table='…')      → columns, FKs, joins
3. search_catalog(joins='…')      → join keys for multi-table questions
4. explore_mssql_schema(table='…')→ confirm exact names (if any doubt)
5. profile_data(table='…', mode='fast') → row scale + keys before heavy SQL
6. query_mssql('SELECT TOP 5 …')  → shape check
7. query_mssql(full analytical SQL) or export_query_to_file
```

For **engine / DMV** questions (fragmentation, waits, columnstore internals):

```
search_catalog(sys='…') → query_mssql(the DMV query)
```

For **lineage / wide views**:

```
inspect_definition(object='…') or search_catalog + inspect_definition(depends_on='…')
```

Never guess column or table names — the catalog and `explore_mssql_schema` exist because names in this estate often violate intuition (`pkClient`, not `clientName`).

---

## 9. Multi-connection vs sync

| Concern | Analysis agent | Sync (`@mia/sync`) |
|---|---|---|
| Connections | `connection='uat'` etc. | `source` + `target` env names |
| Scope | User goal — any tables catalog finds | One entity, published definition tables + predicates only |
| Schema model | Full catalog graph | Per-table drift check on recipe tables |
| Writes | Policy / env access (no connector write latch) | Target MERGE/DELETE in execute |
| Knowledge | `mymi-knowledge.md` + catalog | Published sync definitions bundle |

Same SQL Server driver (`mssql` npm), same `getPool(host, name)` — different orchestration on top.

---

## 10. Mental model

```
Boot
  → register MSSQL connection(s) + optional knowledge markdown
  → build/load CatalogGraph (objects, columns, FKs, implicit joins, sys index) to disk + RAM

Each agent run
  → prompt: connections + knowledge + catalog summary + tool rules
  → discover: search_catalog → explore / discover_relationships / inspect_definition / profile_data
  → analyze: query_mssql (validated, truncated) or export_query_to_file (full export)
  → remember: tool-knowledge cache + run notes keyed by schema fingerprint

Sync (separate)
  → scoped entity diff between two connections — not whole-database traversal
```

**Not** an ORM. **Not** automatic schema inference per query. **Not** unbounded table scans.

It is: **pre-index the entire catalog once**, **search in milliseconds**, **confirm with live tools**, **guard every query**, **profile before touching large/wide objects**, then run T-SQL.
