<!-- mia-pack:shared -->
## Tool Orchestration — How to Approach DB Questions

**Before reaching for database tools, understand what the user is asking.**

If a query uses a technical term you don't immediately recognise (e.g. "tombstone rows",
"ghost records", "forwarded records", "page splits", "fill factor", "latches", "spinlocks",
"WAL", "LSN"), do this first:

1. **Search the internet** — use `fetch_url` to look up the term in context:
   `https://learn.microsoft.com/en-us/search/?terms={term}+SQL+Server`
   or a general search like `https://www.google.com/search?q={term}+SQL+Server+DMV`
2. **Identify the mechanism** — is this an engine-internal concept tracked in a `sys.*` DMV?
   An application pattern in user tables? An OS-level resource?
3. **Then use the right tool**:
   - Engine internals → `search_catalog(sys='…')` to find the DMV, then `query_mssql` to run it
   - Application data → `search_catalog(table='…')` or `search_catalog(column='…')`
   - Unknown DMV columns → `search_catalog(sys='…')` shows all columns with data types

**Why this matters:** SQL Server has 400+ sys.* objects. The `sys=` catalog indexes ALL of them
from the live database — every catalog view, DMV, TVF, and system table — using their actual
column names as the search index. If you search `search_catalog(sys='fragmentation')`, it
finds `dm_db_index_physical_stats` because that object contains a column called
`avg_fragmentation_in_percent`. No curated descriptions or hand-written aliases are involved.

**Canonical example flow:**
```
User: "which tables have tombstone rows?"
→ fetch_url: google "tombstone rows SQL Server"
→ Learn: columnstore index internal state tracked in sys.dm_db_column_store_row_group_physical_stats
→ search_catalog(sys='dm_db_column_store_row_group_physical_stats') — see its columns
→ query_mssql: SELECT ... WHERE state_desc = 'TOMBSTONE'
```

This applies to ANY unfamiliar technical concept — not just SQL Server internals.
Do not guess. Do not assume. Look it up first.

---

For large-table / multi-join work: follow the BIG-TABLE / MICRO-ETL system section when present — do not reinvent staging patterns here.

<!-- /mia-pack:shared -->

<!-- mia-pack:meta -->
## Part 1: Metadata Schemas (ETL Platform Application Data)

These schemas store the configuration, orchestration, and operational state of the ETL platform
that loads, transforms, and publishes the DWH data. They are NOT business data — they describe
HOW the data warehouse is built and managed.

### `core` (46 tables, 39 views)
Central metadata registry. Defines the data model and ETL logic:
- **Datasets**: `Dataset`, `DatasetColumn`, `DatasetColumnDictionary`, `DatasetMapping`, `DatasetMappingColumn` — what data exists, its columns, how it maps between source and target.
- **Contracts**: `Contract`, `ContractColumn` — formal data delivery agreements (structure, schema, expected columns).
- **Rules** (data transformation logic): `Rule`, `RuleColumn`, `RuleCondition`, `RuleConditionValue`, `RuleLink`, `RuleLinkKey`, `RuleLinkType` — the transformation/business rule engine definitions. These define how source data becomes DWH data.
- **Activities & Pipelines**: `Activity`, `ActivityDeployed`, `Pipeline`, `Step`, `Stage`, `Workflow` — ETL pipeline definitions and their deployment state.
- **Config**: `Config`, `LinkedService`, `Domain`, `Component`, `LoadType` — system configuration, data source connections, processing domains.
- **Key core views**: `vDataset`, `vRule`, `vRuleAll`, `vRuleTree`, `vContract`, `vContractColumn`, `vDatasetLineage`, `vWorkflowDailySummaryPivot`.
- Use `vDatasetLineage` to trace data from source through to published output.

### `gate` (31 tables, 13 views)
API gateway / UI layer metadata — users, permissions, content management:
- **Users**: `UserAccount`, `UserInfo`, `UserProfile`, `UserGroup`, `UserGroupMembership`, `UserGroupPermission` — who can access and modify data, roles and permissions.
- **Content**: `Content`, `ContentLink`, `ContentType`, `JsonSchema` — structured content served through the platform UI.
- **Metadata registry**: `MetaColumn`, `MetaTable`, `MetaView` — metadata about database objects themselves (table/column descriptions, data lineage annotations).
- **Notifications**: `Notification`, `NotificationType`, `NotificationUserInfo` — alerts and user notifications.
- **Key gate views**: `vMetaTable`, `vMetaView`, `vUserInfo`, `vNotificationAll`, `vContentFullPath`.

### `log` (11 tables, 5 views)
Run execution logs — tracks every ETL job execution:
- `Detail` (~74M rows) — granular execution log entries (the main audit trail).
- `Sync` (~300K rows) — data synchronization run records.
- `File` — file-based load tracking.
- `QvDatasetRun`, `QvDetail`, `QvDetailTrace`, `QvFile` — QlikView/Qlik dataset processing logs.
- `ShellRun`, `SqlRun` — shell and SQL command execution logs.
- `dataSync` — data sync operation tracking.
- **Key log views**: `vDatasync`, `vQvDatasetRun`, `vQvModelRun`, `vShellRunCommand`, `vSqlRunCommand`.

### `agent` (7 tables, 4 views)
ETL orchestration agent — pipeline execution state:
- `PipelineRun` (~467K rows), `PipelineRunArchive` (~1.5M rows) — pipeline execution history.
- `ActivityRun` (~5.5M rows), `ActivityRunArchive` (~4.4M rows) — individual activity (step) execution records.
- `ActivityRunLog` (~446K rows) — detailed activity execution logging.
- `Semaphore` — concurrency control (prevents parallel runs of the same pipeline).
- `Statistic` — execution statistics.
- **Key agent views**: `vPipelineRun`, `vPipelineLatestRun`, `vPipelineRunContract`, `vSemaphore_syncData`.

### `etl` (368 tables)
Runtime mapping tables generated during ETL execution. Naming pattern:
`mapping_{primaryKey}_{targetTable}_{ruleId}` — e.g. `mapping_pkClient_AfricaFlex_-148`.
These are intermediate lookup tables created by the rule engine during data transformation.
Also contains `ABSA_CUSTOMER` (~31M rows) and `ETL0_Dates`/`ETL0_FileNames` (processing date ranges).

### `map` (7 tables, 1 view)
Cross-reference mapping tables (similar to etl but for specific rule testing).

### `coreArchive` (23 tables), `gateArchive` (19 tables)
Archive schemas — historical copies of modified/deleted records from `core` and `gate` tables.
When a record in core or gate is updated or deleted, the previous version is archived here.

### `master` (10 tables)
Master configuration for the platform infrastructure:
- `Instance`, `LinkedService`, `Config` — environment and service instance configuration with change history tables.

### `audit` (0 tables, 9 views)
Data quality audit views that validate data loads:
- `BalancesSourceFilesLoaded`, `RevenueSourceFilesLoaded`, `RWASourceFilesLoaded`, `VolumessSourceFilesLoaded` — confirm expected source files were loaded.
- `FinancialDisclosure`, `DailyChequeBalances`, `DailySavingsBalances` — reconciliation checks.
- `DataLoadStatistics` — load volume statistics.

---

## Metadata query guidance

**ETL / pipeline / platform questions** (what ran, definitions, rules, contracts):
- Run history: `agent.vPipelineRun`, `agent.vPipelineLatestRun`.
- Activity details: `agent.ActivityRun` / `agent.vPipelineRunContract`.
- Execution logs: `log.Detail`, `log.vDatasync`.
- Pipeline/dataset/rule definitions: `core.vDataset`, `core.Pipeline`, `core.Activity`, `core.vRule`.
- Data quality: `audit.*`; column docs: `gate.vMetaTable` / `gate.vMetaView`.
- Metadata history: `coreArchive.*` / `gateArchive.*`.

**Metadata ↔ runtime:** `core` defines WHAT (pipelines, datasets, rules); `agent` tracks WHEN it ran. JOIN on shared IDs (pipelineId, activityId, datasetId).

Prefer `v*` views when available. Always confirm columns with `explore_mssql_schema` / `search_catalog` before querying.

<!-- /mia-pack:meta -->

<!-- mia-pack:mart -->
## Part 2: DWH / Data Mart Schemas (Business Intelligence Data)

These schemas contain the actual business data — financial transactions, balances, client hierarchies,
risk data, trading, and banking intelligence.

### `dim` (112 tables) — Dimension Tables
Descriptive lookup/reference data. Key dimensions:
- **Client**: `Client` (~26M), `ClientProd` (~14M), `AppPMIClient` (~2.1M), `ClientEmployee` (~2.2M), `ClientFuzzy` (~1.2M), `CIBParent` (~2.8M), `CIBParentFuzzy` (~7.8M) — client master data, fuzzy matching, corporate parent hierarchies.
- **Account**: `Account` (~51M), `AccountType`, `AROAccount` — account dimension with type classification.
- **Book/Desk**: `Book` (~19K), `BookGroup`, `BookGroupFlat`, `BookNode`, `BookNodeSAP` — trading book hierarchy (markets/desks/books).
- **Organization**: `Branch`, `CostCentre`, `CostReportHierarchy`, `Calendar`, `Country`, `Currency`.
- **Product**: `CashProduct`, `Channel`, `Catalog`, `CustomerId`.
- **Date**: `Date` (~55K rows), `DateInterval`, `CalendarCode`.
- **C1V (Client One View)**: `C1V_ComplexEntity` (~6.8M), `C1V_PartyPartyRelationship` (~24M), `C1V_SourceIdentifier` (~30M) — unified client entity resolution from multiple source systems.
- **Compliance**: `CounterpartyCountryOfRisk` — regulatory risk classification.

### `fact` (497 tables, 10 views) — Fact Tables
Transactional and periodic business data. Major fact tables by domain:

**Banking Balances & Financials:**
- `AfricaFlexDailyBalances` (~823M) — daily account-level balances across Africa subsidiaries.
- `AfricaFlex` (~235M), `AfricaBrains` (~20M), `AfricaBrainsDailyBalances` (~107M) — regional banking data.
- `FinancialDisclosureDaily` (~570M), `FinancialDisclosureDailySAP` (~272M) — regulatory financial disclosure.
- `BackdatedTransactions` (~367M) — historical transaction adjustments.

**Risk & Capital:**
- `RWA` (~484M) — Risk-Weighted Assets (Basel regulatory capital).
- `ACMFacility` (~163M), `ACMCounterpartyCreditTeam` (~37M), `ACMAccountFacilityMapping` (~199M) — credit risk / facilities.
- `CounterpartyStructures` (~305M) — counterparty relationship structures.
- `Impairment`, `ImpairmentSAP` — credit loss provisioning (IFRS 9).

**Markets & Trading:**
- `AfricaFrontArena` (~156M), `AfricaFrontArenaMoneyFlow` (~19M) — markets trading data (FrontArena system).
- `AfricaSalesCreditTrades` (~13M), `AfricaSalesCreditTradesCV` (~14M) — sales credit attribution.
- `UnoTranspose` (~2.4B) — largest table, transactional data pivoting.
- `IMEXCommissionsDealBalance` (~1.6B) — commission/fee data.

**Other Domains:**
- `MerchantServices` (~397M) — card acquiring / merchant processing.
- `CardIssuedMonthly`, `CardAccountFinancialSAP` — card issuing.
- `BudgetClientProduct`, `BudgetLock` — budgeting and planning.
- `Expenses` — operational expenses.
- `AfricaCards` (~36M) — card product analytics.

### `ext` (214 tables) — External Loads (Hadoop/Big Data)
Data loaded from Hadoop/HDFS or external big-data systems into SQL Server:
- `BotswanaDailyAccountsAll` (~856M), `GhanaDailyAccountsAll` (~1B), `ZambiaDailyAccountsAll` (~684M) — Africa subsidiary daily account data from Hadoop.
- `AfricaFlexDailyBalancesKenyaCASA` (~222M) — Kenya CASA balances.
- Various other external data loads mirroring fact table structures from big data sources.

### `list` (213 tables, 5 views) — Reference/Lookup Lists
Simple configuration and mapping lists used by business rules:
- `BookToBookGroupMapping`, `BookReplacement` — trading book mappings.
- `AROEntityToClient` (~232K) — entity-to-client resolution.
- `BillRunCustomerLead` (~969K) — billing customer data.
- `AfricaFTPRates` (~50K) — Funds Transfer Pricing rates.
- Various product, segment, and mapping lists.

### `publish` (246 tables, 791 views) — Published Business Data
The primary consumption layer for reports and analytics. Contains:
- **Tables**: Materialized result sets for high-performance querying.
- **Views** (791): The main BI interface — these views are what business users, reports (QlikView, Power BI), and dashboards query. Views typically apply business rules, joins, and aggregations on top of `fact`/`dim` tables.
- Key view categories: Client hierarchies, Book/Desk structures, Balances, Sales Credits, Risk (RWA, ACM, Impairments), Budget, Revenue, Financial Disclosure, Africa regional analytics, Merchant Services, Cards.
- Examples: `publish.Client`, `publish.Book`, `publish.Balances`, `publish.BudgetClientProductRules`, `publish.AfricaSalesCreditTradesRules`, `publish.FinancialDisclosureRules`.

### `persistedView` (356 views) — Indexed/Materialized Views
Performance-optimized materialized views for heavy queries. Named with dot-separated prefixes
indicating their source schema:
- `persistedView.publish.*` (292 views) — persisted versions of publish views.
- `persistedView.source.*` (19 views) — persisted source extracts.
- `persistedView.ext.*` (18 views) — persisted external loads.
- `persistedView.fact.*` (17 views) — persisted fact aggregations.
- `persistedView.map.*` (3 views) — persisted mapping lookups.
- When querying large datasets, prefer `persistedView.publish.X` over `publish.X` if available — same data, better performance.

### `archive` (784 tables)
Historical data archive. When records are deleted or updated in DWH tables, previous versions
are saved here. Naming mirrors the source table. Largest archives:
- `Expenses` (~73M), `MarketRiskRWA` (~64M), `Account` (~30M), `BudgetLock` (~26M).

## Query Guidance

**For business questions** (revenue, balances, clients, risk, trading):
- Start with `publish` views — they are the curated BI layer.
- If a `persistedView.publish.*` version exists, prefer it for performance.
- Join dimensions from `dim` schema (Client, Book, Date, Account, etc.).
- Use `dim.Date` for temporal filtering.

**For ETL/pipeline questions** (what ran, when, status, failures):
- Run history: `agent.vPipelineRun`, `agent.vPipelineLatestRun`.
- Activity details: `agent.ActivityRun` / `agent.vPipelineRunContract`.
- Execution logs: `log.Detail`, `log.vDatasync`.
- Pipeline/dataset definitions: `core.vDataset`, `core.Pipeline`, `core.Activity`.

**For data quality / audit questions:**
- Use `audit.*` views for load verification.
- Use `gate.vMetaTable` / `gate.vMetaView` for column-level documentation.

**For "rules" or "test rules" created/modified by a user:**
- Query `core.Rule` or `core.vRule` with `changedBy LIKE '%<username>%'`.
- `core.Rule` is the ETL transformation rule engine (12K+ rows) with columns `ruleId`, `name`, `changedBy`, `validFrom`, `validTo`, `ruleTypeId`.

**For "what changed" questions:**
- `coreArchive.*` / `gateArchive.*` for metadata changes.
- `archive.*` for DWH data changes.

**For tombstone rows (columnstore index internal state):**
Use `search_catalog(sys='tombstone')` — the sys catalog will identify `sys.dm_db_column_store_row_group_physical_stats` and provide the exact query. Then call `query_mssql` to run it.

**For soft-deleted / logically-deleted rows (isDeleted column):**
See "SCD Type 2 / Soft-Delete Pattern (isDeleted column)" section below.

**Important scale considerations:**
- Several tables exceed 100M+ rows. Always use WHERE clauses with date filters.
- Avoid SELECT * on large tables — specify columns.
- Use `TOP` or date range filters when exploring large fact tables.
- For `dim.Client` (~26M), `dim.Account` (~51M), `fact.AfricaFlexDailyBalances` (~823M) — always filter.

---

## SCD Type 2 / Soft-Delete Pattern (isDeleted column)

For SQL Server internals (tombstones, index health, wait stats, etc.) use `search_catalog(sys='keyword')`.

This DWH uses **SCD Type 2** (Slowly Changing Dimension) logic platform-wide. Every `dim.*`
table and many `publish.*` tables/views carry a standard set of ETL-managed lifecycle columns:

| Column | Type | Meaning |
|---|---|---|
| `isDeleted` | bit | `1` = record is logically deleted. `0` = active. |
| `isDirty` | bit | `1` = record modified since last pipeline run (pending refresh). |
| `validFrom` | datetime | When this version of the record became active. |
| `validTo` | datetime | When this version expired. NULL or far-future date = still active. |
| `checkSum` | varbinary/bigint | Hash of source columns — used to detect changes. |
| `changedBy` | varchar | Pipeline run ID or user who last modified the record. |


---

## Cross-Schema Relationships

Schemas in this database are NOT isolated — they reference each other via ID columns.
When a table lacks data you need, a related table in another schema likely has it.

**Metadata ↔ Runtime pattern:**
- `core` schema defines WHAT exists (pipelines, activities, datasets, rules).
- `agent` schema tracks WHEN it ran (pipeline runs, activity runs, status).
- These link via shared ID columns (e.g., pipelineId, activityId, datasetId).
- To combine "what" with "when" (e.g., pipeline name + run duration), JOIN across schemas.

**Fact ↔ Dimension pattern (star schema):**
- `fact` tables contain measures (amounts, counts, dates) with foreign key IDs.
- `dim` tables contain descriptive attributes (names, categories, hierarchies).
- JOIN fact to dim on shared key columns to get meaningful labels for IDs.

**publish views = pre-joined data:**
- `publish` views typically JOIN fact + dim + rules already.
- Start here for business questions — avoids manual multi-table joins.
- If publish doesn't have what you need, fall back to fact + dim.

**Views (prefixed with `v`) = pre-joined convenience:**
- In any schema, views starting with `v` (e.g., `vPipelineRun`, `vDataset`) usually combine related base tables.
- Prefer views over base tables when available — they include common joins.
- But views may omit columns — always check with explore_mssql_schema.

**archive mirrors source structure:**
- `archive.*` tables have the same columns as their source tables, plus archive metadata.
- `coreArchive` / `gateArchive` mirror `core` / `gate` tables.

---

## Discovery Workflow

For ANY database question, follow this process — **never skip steps**:

1. **Identify the domain**: Use the schema descriptions above to determine which schema(s) are relevant.
   - Revenue/balances/clients → `publish`, `fact`, `dim`
   - Pipeline/ETL/jobs → `agent`, `core`
   - Data quality → `audit`, `gate`

2. **Search the catalog**: Use `search_catalog(search='keyword')` to find tables/views matching your topic.
   - `search_catalog(search='revenue client')` — finds client revenue views and tables
   - `search_catalog(search='profitability')` — finds profitability views
   - `search_catalog(search='balance daily')` — finds balance tables
   - The catalog returns columns, types, FKs, row counts — enough to pick the right table.
   - **Prefer publish views** in the results — they are pre-joined business-ready data.
   - If a `persistedView.publish.X` exists for the same object, use it for better performance.

3. **Check joins**: Use `search_catalog(joins='schema.Table')` to see FK + implicit join edges.
   - This tells you exactly which tables can be joined and on what columns.

4. **Discover columns**: Use `explore_mssql_schema(table='schema.TableName')` to get EXACT column names.
   Do this for EVERY table you plan to query. Never guess column names.

5. **Test small first**: Run `SELECT TOP 5 ...` to verify the query works and data looks right.

6. **Scale up**: Only after confirming the shape, write the full query with filters and aggregations.

### Common Business Question Hints

These are **suggested starting points** for common analytical questions. They may not always be correct
or up-to-date. ALWAYS verify with `search_catalog` — the catalog's rich metadata (row count, column count,
joins, centrality) will help you pick the best table. Trust structural signals over these hints.

⚠️ **COLUMN NAMES ARE NOT LISTED HERE — always verify with `explore_mssql_schema` before querying.**
This database uses a `pk*` convention for primary keys (`pkClient`, `pkProduct`, `pkMonth`, `pkDate`, etc.)
and `Name` for display names. Generic names like `clientName`, `revenue`, `reportDate` almost certainly
do NOT exist — using them will produce `Invalid column name` errors.

**Verified key columns (confirmed from live schema):**
- `dim.Date`: `pkDate` (PK int), `pkMonth` (int FK→dim.Month), `Year` (smallint), `MonthNo` (smallint), `QuarterNo` (smallint), `Period` (varchar), `FullDate` (date)
- `dim.Client`: `pkClient` (PK), `Name` (display name) — 26M rows, always filter by `pkClient`
- `dim.Product`: `pkProduct` (PK), `Name` (display name)
- `publish.Revenue`: `pkClient`, `pkProduct`, `pkMonth`, `RevenueZARMTD` (ZAR month-to-date revenue)

| Business Question | Suggested Table | Notes |
|---|---|---|
| Client revenue / profitability | `publish.Revenue` or `publish.ClientProfitability` | Revenue view needs pkMonth filter (see pattern below). Verify table exists with search_catalog first. |
| Revenue by P&L / book | `fact.PNLRevenueMTD` | Month-to-date P&L. Always run explore_mssql_schema to get exact column names before querying. |
| Account balances | `publish.Balances` or `fact.AfricaFlexDailyBalances` | publish view is pre-joined; fact table needs dim.Account join. Verify columns first. |
| Client details / hierarchy | `dim.Client` + `dim.CIBParent` | 26M rows — always filter by `pkClient`. Join key: `pkClient`. |
| Month / calendar / time grouping | `dim.Date` joined to `dim.Month` | Default reporting month: filter/group on `dim.Date.pkMonth` (FK → `dim.Month`). Do not ask which "month" table — use this path unless the user explicitly wants accounting month (`pkAccountingMonth`). |
| ABSA customer filter | `etl.ABSA_CUSTOMER` or `dim.Client` | This deployment is ABSA's MyMI warehouse — "ABSA" refers to the bank's customer universe, not an unknown business term. |
| Sales credits | `publish.AfricaSalesCreditTradesRules` | Pre-joined view with rules applied. Verify column names with explore_mssql_schema. |
| Risk (RWA) | `fact.RWA` | 484M rows — mandatory date filter. Verify column names before use. |
| Pipeline runs / ETL status | `agent.vPipelineRun` | Use the view, not the base table. Verify columns with explore_mssql_schema. |
| Merchant services | `fact.MerchantServices` | 397M rows — date filter required. Verify column names before use. |
| Financial disclosure | `fact.FinancialDisclosureDaily` | 570M rows — always filter by date range. Verify column names before use. |

**NOTE**: If the suggested table doesn't match your search_catalog results, trust the catalog.
Use `search_catalog(column='revenue')` to find ALL tables with a given column, then compare metadata.

---


## Part 4: Critical View Lineage

Lineage maps are stored in the schema catalog and cover **every view in the database** —
not just the two hand-curated critical views. The catalog builds lineage dynamically at
startup using `sys.sql_expression_dependencies` (a metadata-only query that runs in
milliseconds) and requires no configuration.

**For each view, the catalog records automatically:**
- All direct source tables and views (one level deep)
- Output columns (from the live schema)
- Dimension joins — auto-detected from `pk*` column naming (`pkClient` → `dim.Client`, etc.)
- Source grouping by schema

**Hand-curated additions** (in `deploy/mssql/publish-views-curation.json`) add richer context for the two most
critical views: business area groupings (RBB, UNO, CPA, Africa, IMEX, etc.), filter conditions
per source, and narrative descriptions. These always overwrite the auto-discovered entries.

**To inspect dependencies (catalog v7 — lineage/concepts modes removed):**
- `inspect_definition(depends_on='publish.Revenue')` → T-SQL sources / dependency chain
- `inspect_definition(depends_on='publish.Balances')` → same for Balances
- `search_catalog(search='Revenue')` / `search_catalog(table='publish.Revenue')` → catalog keyword / table detail
- `search_catalog(stats=true)` → largest views / catalog summary

**What dependency inspection tells you:**
- Which source tables/views feed into a publish view
- Which dimension tables join via pk* keys (when visible in the definition)
- For curated views: filter conditions applied to each source, business area breakdown

**Use dependency inspection for:**
- Tracing a revenue number to its source fact table
- Finding which business lines a client participates in
- Cross-sell analysis (products used vs. not used, compared to peer clients)
- Understanding what `inspect_definition(object=…)` will reveal when drilling deeper

<!-- /mia-pack:mart -->
