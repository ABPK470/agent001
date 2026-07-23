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

`isDeleted` is an application-level flag set by the ETL pipeline — **not** a columnstore tombstone.
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

**To find ALL tables with an `isDeleted` column:**
```
search_catalog(column='isDeleted')
```

Confirmed on key dim tables:
- `dim.Client` (~26M rows), `dim.Book` (~19K rows), `dim.CostCentre` (~79K rows)
- All `publish.Client*` views, `publish.BookManage`, `publish.CostCentre*`

```sql
-- Find logically-deleted clients
SELECT TOP 10 pkClient, Name, validFrom, validTo
FROM dim.Client WITH (NOLOCK)
WHERE isDeleted = 1
```

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

## Scale & Efficiency Reference

This database is approximately **2TB** of data across hundreds of schemas and tables.
Always treat it as a high-scale system — unfiltered queries on large tables will time out or cause load spikes.

### Largest tables (row counts at last observation)

| Table | Rows | Notes |
|---|---|---|
| `fact.UnoTranspose` | ~2.4 billion | Transactional data pivot — NEVER scan without filters |
| `fact.IMEXCommissionsDealBalance` | ~1.6 billion | Fee/commission data — always date-filter |
| `ext.GhanaDailyAccountsAll` | ~1 billion | External Hadoop load |
| `ext.BotswanaDailyAccountsAll` | ~856 million | External Hadoop load |
| `fact.AfricaFlexDailyBalances` | ~823 million | Daily balances — use date ranges |
| `fact.FinancialDisclosureDaily` | ~570 million | Regulatory disclosure |
| `fact.FinancialDisclosureDailySAP` | ~272 million | SAP variant |
| `fact.BackdatedTransactions` | ~367 million | Backdated adjustments |
| `fact.CounterpartyStructures` | ~305 million | Counterparty risk |
| `fact.ACMAccountFacilityMapping` | ~199 million | Credit facilities |
| `fact.AfricaFrontArena` | ~156 million | Markets trading |
| `dim.Account` | ~51 million | Always filter before joining |
| `dim.Client` | ~26 million | Central client master — heavy join target |
| `agent.ActivityRun` | ~5.5 million | ETL activity execution records |
| `agent.ActivityRunArchive` | ~4.4 million | Historical activity runs |
| `log.Detail` | ~74 million | Granular ETL execution logs |

### Query efficiency rules

- **Always date-filter**: Every query on `fact.*`, `ext.*`, `archive.*` MUST have a date WHERE clause.
- **Use TOP for exploration**: Start every investigation with `SELECT TOP 10` — never `SELECT *` cold.
- **Prefer persistedViews**: `persistedView.publish.X` is pre-materialized. Use it instead of `publish.X` when available for the same result at a fraction of the I/O.
- **Avoid SELECT ***: On any table with 1M+ rows, specify only the columns you need.
- **Date dimension**: Use `dim.Date` for all temporal filtering. Verified columns: `Year` (smallint), `MonthNo` (smallint), `QuarterNo` (smallint), `pkDate` (int PK), `pkMonth` (int). Never use `calYear`, `calMonth`, `calYearMonth` — those columns do NOT exist. Filter using `WHERE Year = 2025`, not `WHERE calYear = 2025`.
- **dim.Client and dim.Account**: These are the most-joined tables in the system. Both are very large. Filter on primary key values (`pkClient`, `pkAccount`) rather than scanning.

### ⚠️ CRITICAL: Never probe views with ORDER BY or unfiltered queries

`publish.*` views are NOT tables — they are T-SQL view definitions that UNION together 10–60 underlying
fact tables at runtime. Every query against a `publish.*` view re-executes the entire view.

**NEVER do this — it will time out (minutes) or never complete:**
```sql
SELECT TOP 5 pkMonth FROM publish.Revenue ORDER BY pkMonth         -- FULL SCAN of 59 unioned fact tables
SELECT TOP 5 * FROM publish.Revenue                                 -- same — forces full materialization
SELECT MIN(pkMonth), MAX(pkMonth) FROM publish.Revenue              -- same issue
SELECT DISTINCT pkMonth FROM publish.Revenue                        -- extremely slow
```

**Why it's slow:** `SELECT TOP N ... ORDER BY` on a view forces SQL Server to evaluate the entire view
(all 59+ UNION branches across multiple 100M+ row fact tables) to find the globally sorted top-N.
There is no index SQL Server can use on the result of a view with UNIONs.

### ✅ How to discover date ranges on publish.* views efficiently

The `pkMonth` key is sourced from `dim.Date.pkDate` (or a `CalendarCode` lookup). To find what period
data is available WITHOUT querying the view:

```sql
-- Option 1: Query dim.Date directly — find all months that exist
-- VERIFIED column names: Year (smallint), MonthNo (smallint), Period (varchar), pkDate (int), pkMonth (int)
SELECT DISTINCT pkMonth, Year, MonthNo, Period FROM dim.Date
WHERE Year = 2025
ORDER BY pkMonth

-- Option 2: Check the underlying fact table (much faster than the view)
-- publish.Revenue is built from fact tables. Use inspect_definition(depends_on='publish.Revenue')
-- to find which base fact tables feed it, then query those directly with TOP 1 + date filter.
-- Example with a single source:
SELECT TOP 1 pkMonth FROM fact.PNLRevenueMTD WITH (NOLOCK) ORDER BY pkMonth DESC

-- Option 3: For the Revenue view specifically, check the month dimension:
SELECT pkMonth, Year, MonthNo, Period
FROM dim.Date WITH (NOLOCK)
WHERE Year = 2025
ORDER BY pkMonth
```

### ✅ How to query large publish.* views efficiently

When querying `publish.Revenue` or similar large views, ALWAYS anchor with a filter that matches
an indexed column on the underlying base tables:

```sql
-- CORRECT: pkMonth filter pushes predicate into the view — each source table can use its index
-- ALWAYS look up the pkMonth range from dim.Date first (see pattern below) — never hardcode values
SELECT pkClient, SUM(RevenueZARMTD) AS revenue
FROM publish.Revenue WITH (NOLOCK)
WHERE pkMonth BETWEEN @pkMonthFrom AND @pkMonthTo   -- resolve from dim.Date first!
GROUP BY pkClient

-- CONDITIONAL: use a persisted publish mirror ONLY if that exact mirror exists.
-- Do NOT assume `persistedView.[publish.Revenue]` exists in every environment.
-- If no one-to-one persisted publish mirror exists, do NOT blindly substitute
-- `persistedView.[fact.Revenue]` and expect the same performance shape.

-- FALLBACK FOR publish.Revenue: aggregate inside each source branch first,
-- then UNION the small grouped results, then take TOP N clients.
-- This matches the actual lineage shape of publish.Revenue in this repo:
-- 59 source-mapping views under one UNION ALL.
```

### ✅ When no `persistedView.[publish.Revenue]` mirror exists

`publish.Revenue` in this repo is documented as a `UNION ALL` over 59 source-mapping views.
When there is no one-to-one persisted publish mirror, the best-performing pattern for enterprise
top-N client discovery is usually:

1. Resolve `pkMonth` from `dim.Date`
2. Aggregate by `pkClient` inside each revenue branch with the `pkMonth` predicate applied
3. `UNION ALL` those branch-local aggregates
4. Group again by `pkClient` and take `TOP N`
5. Only then fetch detail rows for those clients from `publish.Revenue`

Example skeleton:

```sql
SET NOCOUNT ON;

SELECT MIN(pkMonth) AS pkMonthFrom, MAX(pkMonth) AS pkMonthTo
INTO #range_a3f91c08
FROM dim.Date WITH (NOLOCK)
WHERE [Year] = 2025;

SELECT TOP 5
      x.pkClient,
      SUM(x.RevenueZAR) AS RevenueZAR
INTO #topClients_a3f91c08
FROM (
      SELECT pkClient, SUM(RevenueZARMTD) AS RevenueZAR
      FROM publish.MappingTransactionalBankingRules WITH (NOLOCK)
      WHERE pkMonth BETWEEN (SELECT pkMonthFrom FROM #range_a3f91c08)
                                 AND (SELECT pkMonthTo   FROM #range_a3f91c08)
         AND pkClient IS NOT NULL
      GROUP BY pkClient

      UNION ALL

      SELECT pkClient, SUM(RevenueZARMTD) AS RevenueZAR
      FROM publish.MappingUNOTranspose WITH (NOLOCK)
      WHERE pkMonth BETWEEN (SELECT pkMonthFrom FROM #range_a3f91c08)
                                 AND (SELECT pkMonthTo   FROM #range_a3f91c08)
         AND pkClient IS NOT NULL
      GROUP BY pkClient

      -- repeat for the required revenue branches
) x
GROUP BY x.pkClient
ORDER BY SUM(x.RevenueZAR) DESC, x.pkClient;

SELECT
      r.pkClient,
      r.pkProduct,
      r.pkAccount,
      r.pkMonth,
      r.RevenueZARMTD
INTO #revLines_a3f91c08
FROM publish.Revenue r WITH (NOLOCK)
JOIN #range_a3f91c08 rg
   ON r.pkMonth BETWEEN rg.pkMonthFrom AND rg.pkMonthTo
WHERE r.pkClient IN (SELECT pkClient FROM #topClients_a3f91c08);

DROP TABLE #revLines_a3f91c08;
DROP TABLE #topClients_a3f91c08;
DROP TABLE #range_a3f91c08;
```

Why this helps:
- it shrinks rows inside each branch before the global `UNION ALL`
- it avoids asking SQL Server to sort or aggregate the fully-expanded 59-branch union first
- it delays large dim joins until the client set is already tiny

### ✅ pkMonth lookup pattern

`pkMonth` in `publish.Revenue` corresponds to `pkMonth` in `dim.Date` (NOT `pkDate` — these are different columns).
**Always resolve the pkMonth range before querying Revenue:**

```sql
-- Step 1: Resolve pkMonth values for the target period
-- dim.Date column names: Year (smallint), MonthNo (smallint), pkDate (int), pkMonth (int)
SELECT MIN(pkMonth) AS pkMonthFrom, MAX(pkMonth) AS pkMonthTo
FROM dim.Date WITH (NOLOCK)
WHERE Year = 2025

-- Step 2: Use those values as filters in publish.Revenue
SELECT TOP 20 pkClient, SUM(RevenueZARMTD) AS totalRevenue
FROM publish.Revenue WITH (NOLOCK)
WHERE pkMonth BETWEEN @pkMonthFrom AND @pkMonthTo
GROUP BY pkClient
ORDER BY totalRevenue DESC

-- Step 3: Look up client names (join to dim.Client on pkClient)
-- dim.Client column: Name (client display name)
SELECT Name FROM dim.Client WITH (NOLOCK) WHERE pkClient = @pkClient

-- Step 4: Look up top product per client
-- dim.Product column: Name (product display name); join key: pkProduct
SELECT TOP 1 p.Name AS ProductName, SUM(r.RevenueZARMTD) AS ProductRevenue
FROM publish.Revenue r WITH (NOLOCK)
JOIN dim.Product p WITH (NOLOCK) ON r.pkProduct = p.pkProduct
WHERE r.pkClient = @pkClient AND r.pkMonth BETWEEN @pkMonthFrom AND @pkMonthTo
GROUP BY p.Name
ORDER BY ProductRevenue DESC
```

### Key discovery rule: use catalog metadata, not view queries, for exploration

Before querying a large view:
1. `inspect_definition(depends_on='publish.Revenue')` — see source tables / dependency map
2. Query `dim.Date` to resolve any `pkDate/pkMonth` values for your time period  
3. Only then query the view, WITH a predicate on `pkMonth`/`pkDate` that uses the resolved range
4. Add `WITH (NOLOCK)` for analytical read-only queries — avoids lock contention on live systems

### publish vs persistedView vs fact+dim

```
Business question
  └── publish.X (view — pre-joined fact+dim, business-ready)
        └── persistedView.publish.X (materialized — same as publish.X but stored)
              └── fact.X + dim.Y (base tables — flexible but requires manual joins)
```

**For reporting**: always start at `persistedView.publish.*` if it exists; fall back to `publish.*`, then `fact+dim`.
**For raw data / custom joins**: go to `fact` + `dim` directly.

### View layer architecture

The platform has 4 view layers stacked on top of base tables:
1. **`core.*` views** (`vDataset`, `vRule`, etc.) — metadata/config pre-joins
2. **`publish.*` views** (246+) — business-ready star-schema joins; what BI tools query
3. **`persistedView.publish.*`** (292) — SQL Server indexed views materializing `publish.*`
4. **`audit.*` views** (9) — data quality monitors

When diagnosing slow ETL or long pipeline runs, the problem is often in **`publish.*` view definitions**:
- Duplicate JOINs to the same table (e.g., joining `dim.Client` twice)
- Joining through `publish.*` views inside other `publish.*` views (N-level view nesting)
- Joining `fact.*` tables without adequate WHERE predicates — they get full scans

Use `inspect_definition(object='publish.ViewName')` to read the T-SQL and detect these patterns.
Use `inspect_definition(depends_on='publish.ViewName')` to trace the full view chain.
Use `inspect_definition(search='TableName')` to find every view that joins a specific table.

### Correct workflow for finding top-N largest publish views and their duplicate joins

The catalog pre-computes view rankings at startup using `sys.sql_expression_dependencies` —
a catalog metadata DMV that runs in milliseconds. There is no need to write a runtime SQL query.

**Step 1 — `search_catalog(stats=true)`**

Returns two sections:
- "Largest tables" — physical tables. The `publish.*` entries there (`ZambiaDailyAccountsAll`,
  `MappingAfricaEMDWDailyBalances`, `AfricaFlexDailyBalances`, etc.) are physical tables —
  `inspect_definition` on them returns "No definition found". **Ignore this list for view analysis.**
- "Largest publish VIEWS (by sum of source table rows)" — real publish VIEWs with T-SQL
  definitions, ranked by the total rows of the physical tables they reference.

**Step 2 — for each view in "Largest publish VIEWS", call in PARALLEL:**
```
inspect_definition(object='publish.ViewName')
```
→ check "TABLE/VIEW REFERENCES IN FROM/JOIN CLAUSES"
→ any table name listed more than once = confirmed duplicate join

**Notes:**
- `publish.Revenue` and `publish.Balances` are UNION-ALL aggregations — always return
  "No duplicate table references" — correct, skip them.
- The customer-reported issue (joining `publish.Client_Base` twice) will appear in one of the
  large publish views returned by Step 1.

### ETL pipeline performance analysis

When a pipeline is slow, trace it through three layers:
1. **What ran?** → `agent.vPipelineRun`, `agent.vPipelineLatestRun` — get duration and status
2. **Which activity was slow?** → `agent.ActivityRun` — find the step with the longest elapsed time
3. **What query did it run?** → `core.Rule`, `core.vRule` — read the rule definition for that activity
4. **Why was it slow?** → `inspect_definition(object='...')` on any view the rule references

Common performance causes found this way:
- Redundant JOIN to the same dimension (e.g., `client_base` twice in one SELECT)
- A `publish` view calling another `publish` view that itself calls a 500M-row fact table without filters
- Missing indexes on join columns in large `fact` tables
- `SELECT *` inside a view definition causing over-fetch

### etl schema (368 tables)
These mapping tables (`mapping_*`) are generated dynamically per pipeline run. They are typically small
(lookup tables for a single transformation run) but there are hundreds of them. When debugging a rule, 
the relevant mapping table can be found via:
```sql
SELECT * FROM INFORMATION_SCHEMA.TABLES 
WHERE TABLE_SCHEMA = 'etl' AND TABLE_NAME LIKE '%TargetTableName%'
ORDER BY TABLE_NAME
```

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

