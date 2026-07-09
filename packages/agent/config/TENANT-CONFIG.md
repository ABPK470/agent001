# Tenant config

## What it is

**One `tenant.json` per mia server install** — the machine + database this instance serves.

Not per user. Not multi-tenant inside one process.

| File | Consumer | Purpose |
|------|----------|---------|
| `tenant.json` | mia **code** | Warehouse conventions the catalog cannot infer |
| `mymi-knowledge.md` | the **LLM** | Prose schema guide (separate file, `MSSQL_KNOWLEDGE_FILE`) |
| `definitions.bundle.json` | mia **code** + sync runtime | Published sync entity types — **not** created by setup or first boot |

## Boot

```bash
MIA_TENANT_CONFIG=./deploy/tenant.json
```

1. Parse `tenant.json` once → `getTenantConfig()` singleton  
2. Seed entities into SQLite (first boot only) from `deploy/sync/artifacts`  
3. Load `sync-definitions/published/definitions.bundle.json` if it exists (after publish)  

Logs:

```
Tenant config loaded: .../deploy/tenant.json (mirror=persistedview, domainKeywords=39, ...)
Published sync vocabulary: 6 entity types (content, contract, dataset, gateMetadata, pipelineActivity, rule)
```

If the bundle is missing (normal before first publish):

```
Published sync bundle: not found — sync preview/execute disabled until you publish.
  After first start: Entity Registry → ⚙ → Publish
```

**Publish is required for sync** — it is not part of `npm run setup`. After first server start: Entity Registry → ⚙ → Publish. Vocabulary reloads immediately (no restart).

## What goes in `tenant.json`

Only what **cannot** be derived at runtime:

| Key | Example | Used for |
|-----|---------|----------|
| `mirrorSchema` | `"persistedview"` | Mirror lookup, SQL validation, resolved facts |
| `domainKeywords` | `["revenue", "rwa", "mymi"]` | Goal gating + clarify — **words users actually type** |
| `schemaRanking` | `[{ "schema": "publish", "weight": 50 }]` | `search_catalog` ordering |
| `largeObjectRows` | `10000000` | SQL “large object” threshold |
| `unionBranchThreshold` | `8` | UNION view doctrine |
| `preAggregationTokens` | `["Average", "MTD", …]` | Block wrong `SUM` patterns |
| `aliasFamilies` | `{ "prefix": "Sum", "aggregate": "SUM" }` | SQL alias validation |
| `reservedAliases` | `["publish", "fact"]` | Disallowed SQL aliases |
| `catalogBootstrap` | optional object | **Tests/offline only** — omit in production |

## What does NOT go in `tenant.json`

| Do not put here | Comes from instead |
|-----------------|-------------------|
| Schema names (`publish`, `fact`) | Live MSSQL catalog |
| Sync entity ids (`pipelineActivity`, `gateMetadata`) | `definitions.bundle.json` after publish |
| Table/column lists | Catalog introspection |
| SQL examples / schema descriptions | `mymi-knowledge.md` |

## Per-run behaviour (goal classification)

**Once per agent run** (not per LLM call), the user's goal text is scored:

```
goal text
  ├─ Universal patterns (hardcoded): "SELECT", "sync from uat to prod", "revenue" (BI_DOMAIN_RE), …
  ├─ tenant.domainKeywords → +2 DB score if matched
  ├─ catalog schema names → operational SQL detection (publish.Revenue)
  ├─ published sync entity ids → syncIntent if "pipelineActivity" in goal (after publish)
  └─ score ≥ 2 → keep MSSQL tools; syncIntent → keep sync tools
```

Without a published bundle, universal patterns still catch most sync goals; exact entity-id matching activates after publish.

No loop over the JSON file. Keywords are compiled to regex once and cached.

**Per `query_mssql` call:** `mirrorSchema`, thresholds, validator tokens.

## `domainKeywords` — what to list

Words your users say that are **specific to this warehouse** and not already caught by universal patterns:

- Business terms: `rwa`, `africaflex`, `FrontArena`
- Product names operators mention: `mymi`, `uspSync`

Do **not** list internal entity registry ids here — those load from the sync bundle after publish.

## Files

| Path | Role |
|------|------|
| `packages/agent/config/tenant.example.json` | Template — copy like `.env.example` |
| `deploy/tenant.json` | Shipped MyMI config |
| `deploy/mssql/mymi-knowledge.md` | LLM knowledge companion |

## Copy workflow

```bash
cp packages/agent/config/tenant.example.json deploy/tenant.json
# edit domainKeywords + mirrorSchema for your warehouse
```
