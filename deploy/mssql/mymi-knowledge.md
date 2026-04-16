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
- **Testing**: `Test`, `TestAction`, `TestActionHistory` — data quality test definitions and results.
- **Key gate views**: `vMetaTable`, `vMetaView`, `vUserInfo`, `vNotificationAll`, `vContentFullPath`.

### `log` (11 tables, 5 views)
Run execution logs — tracks every ETL job execution:
- `Detail` (~72M rows) — granular execution log entries (the main audit trail).
- `Sync` (~300K rows) — data synchronization run records.
- `File` — file-based load tracking.
- `QvDatasetRun`, `QvDetail`, `QvDetailTrace`, `QvFile` — QlikView/Qlik dataset processing logs.
- `ShellRun`, `SqlRun` — shell and SQL command execution logs.
- `dataSync` — data sync operation tracking.
- **Key log views**: `vDatasync`, `vQvDatasetRun`, `vShellRunCommand`, `vSqlRunCommand`.

### `agent` (7 tables, 4 views)
ETL orchestration agent — pipeline execution state:
- `PipelineRun` (~457K rows), `PipelineRunArchive` (~1.5M rows) — pipeline execution history.
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
- `AfricaFlexDailyBalances` (~798M) — daily account-level balances across Africa subsidiaries.
- `AfricaFlex` (~235M), `AfricaBrains` (~20M), `AfricaBrainsDailyBalances` (~107M) — regional banking data.
- `FinancialDisclosureDaily` (~570M), `FinancialDisclosureDailySAP` (~272M) — regulatory financial disclosure.
- `BackdatedTransactions` (~367M) — historical transaction adjustments.

**Risk & Capital:**
- `RWA` (~484M) — Risk-Weighted Assets (Basel regulatory capital).
- `ACMFacility` (~163M), `ACMCounterpartyCreditTeam` (~37M), `ACMAccountFacilityMapping` (~199M) — credit risk / facilities.
- `CounterpartyStructures` (~294M) — counterparty relationship structures.
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

### `ext` (216 tables) — External Loads (Hadoop/Big Data)
Data loaded from Hadoop/HDFS or external big-data systems into SQL Server:
- `BotswanaDailyAccountsAll` (~852M), `GhanaDailyAccountsAll` (~1B), `ZambiaDailyAccountsAll` (~682M) — Africa subsidiary daily account data from Hadoop.
- `AfricaFlexDailyBalancesKenyaCASA` (~222M) — Kenya CASA balances.
- Various other external data loads mirroring fact table structures from big data sources.

### `list` (212 tables, 5 views) — Reference/Lookup Lists
Simple configuration and mapping lists used by business rules:
- `BookToBookGroupMapping`, `BookReplacement` — trading book mappings.
- `AROEntityToClient` (~232K) — entity-to-client resolution.
- `BillRunCustomerLead` (~969K) — billing customer data.
- `AfricaFTPRates` (~50K) — Funds Transfer Pricing rates.
- Various product, segment, and mapping lists.

### `publish` (248 tables, 790 views) — Published Business Data
The primary consumption layer for reports and analytics. Contains:
- **Tables**: Materialized result sets for high-performance querying.
- **Views** (790): The main BI interface — these views are what business users, reports (QlikView, Power BI), and dashboards query. Views typically apply business rules, joins, and aggregations on top of `fact`/`dim` tables.
- Key view categories: Client hierarchies, Book/Desk structures, Balances, Sales Credits, Risk (RWA, ACM, Impairments), Budget, Revenue, Financial Disclosure, Africa regional analytics, Merchant Services, Cards.
- Examples: `publish.Client`, `publish.Book`, `publish.Balances`, `publish.BudgetClientProductRules`, `publish.AfricaSalesCreditTradesRules`, `publish.FinancialDisclosureRules`.

### `persistedView` (354 views) — Indexed/Materialized Views
Performance-optimized materialized views for heavy queries. Named with dot-separated prefixes
indicating their source schema:
- `persistedView.publish.*` (292 views) — persisted versions of publish views.
- `persistedView.source.*` (19 views) — persisted source extracts.
- `persistedView.ext.*` (18 views) — persisted external loads.
- `persistedView.fact.*` (17 views) — persisted fact aggregations.
- `persistedView.map.*` (3 views) — persisted mapping lookups.
- When querying large datasets, prefer `persistedView.publish.X` over `publish.X` if available — same data, better performance.

### `archive` (783 tables)
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
- Check `gate.Test` / `gate.TestAction` for test definitions and results.
- Use `gate.vMetaTable` / `gate.vMetaView` for column-level documentation.

**For "what changed" questions:**
- `coreArchive.*` / `gateArchive.*` for metadata changes.
- `archive.*` for DWH data changes.

**Important scale considerations:**
- Several tables exceed 100M+ rows. Always use WHERE clauses with date filters.
- Avoid SELECT * on large tables — specify columns.
- Use `TOP` or date range filters when exploring large fact tables.
- For `dim.Client` (~26M), `dim.Account` (~51M), `fact.AfricaFlexDailyBalances` (~798M) — always filter.

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

| Business Question | Suggested Table | Key Columns | Notes |
|---|---|---|---|
| Client revenue / profitability | `publish.ClientProfitability` | clientName, revenue, product, bookName | Check catalog for alternatives — multiple tables may have revenue data. |
| Revenue by P&L / book | `fact.PNLRevenueMTD` | bookId, revenue, reportDate | Month-to-date P&L revenue. Join `dim.Book` for book names. |
| Account balances | `publish.Balances` or `fact.AfricaFlexDailyBalances` | accountId, balance, effectiveDate | publish view is pre-joined; fact table needs dim.Account join. |
| Client details / hierarchy | `dim.Client` + `dim.CIBParent` | clientId, clientName, parentName | dim.Client is 26M rows — always filter by clientId. |
| Sales credits | `publish.AfricaSalesCreditTradesRules` | clientId, tradeId, salesCredit | Pre-joined view with rules applied. |
| Risk (RWA) | `fact.RWA` | rwaAmount, clientId, reportDate | 484M rows — mandatory date filter. |
| Pipeline runs / ETL status | `agent.vPipelineRun` | pipelineId, status, startDate, duration | Use the view, not the base table. |
| Merchant services | `fact.MerchantServices` | merchantId, revenue, transactionDate | 397M rows — date filter required. |
| Financial disclosure | `fact.FinancialDisclosureDaily` | amount, accountId, reportDate | 570M rows — always filter by date range. |

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
| `ext.BotswanaDailyAccountsAll` | ~852 million | External Hadoop load |
| `fact.AfricaFlexDailyBalances` | ~798 million | Daily balances — use date ranges |
| `fact.FinancialDisclosureDaily` | ~570 million | Regulatory disclosure |
| `fact.FinancialDisclosureDailySAP` | ~272 million | SAP variant |
| `fact.BackdatedTransactions` | ~367 million | Backdated adjustments |
| `fact.CounterpartyStructures` | ~294 million | Counterparty risk |
| `fact.ACMAccountFacilityMapping` | ~199 million | Credit facilities |
| `fact.AfricaFrontArena` | ~156 million | Markets trading |
| `dim.Account` | ~51 million | Always filter before joining |
| `dim.Client` | ~26 million | Central client master — heavy join target |
| `agent.ActivityRun` | ~5.5 million | ETL activity execution records |
| `agent.ActivityRunArchive` | ~4.4 million | Historical activity runs |
| `log.Detail` | ~72 million | Granular ETL execution logs |

### Query efficiency rules

- **Always date-filter**: Every query on `fact.*`, `ext.*`, `archive.*` MUST have a date WHERE clause.
- **Use TOP for exploration**: Start every investigation with `SELECT TOP 10` — never `SELECT *` cold.
- **Prefer persistedViews**: `persistedView.publish.X` is pre-materialized. Use it instead of `publish.X` when available for the same result at a fraction of the I/O.
- **Avoid SELECT ***: On any table with 1M+ rows, specify only the columns you need.
- **Date dimension**: Use `dim.Date` for all temporal filtering — it has pre-computed period attributes (fiscal year, quarter, month). Never compute date logic in WHERE; join to `dim.Date` instead.
- **dim.Client and dim.Account**: These are the most-joined tables in the system. Both are very large. Filter on key values (clientId, accountId) rather than scanning.

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
SELECT DISTINCT pkDate, calYear, calMonth FROM dim.Date
WHERE calYear = 2025
ORDER BY pkDate

-- Option 2: Check the underlying fact table (much faster than the view)
-- publish.Revenue is built from fact tables. Use search_catalog(lineage='publish.Revenue')
-- to find which base fact tables feed it, then query those directly with TOP 1 + date filter.
-- Example with a single source:
SELECT TOP 1 pkMonth FROM fact.PNLRevenueMTD WITH (NOLOCK) ORDER BY pkMonth DESC

-- Option 3: For the Revenue view specifically, check the month dimension:
SELECT pkDate, calYear, calMonth, calYearMonth
FROM dim.Date WITH (NOLOCK)
WHERE calYear = 2025
ORDER BY pkDate
```

### ✅ How to query large publish.* views efficiently

When querying `publish.Revenue` or similar large views, ALWAYS anchor with a filter that matches
an indexed column on the underlying base tables:

```sql
-- CORRECT: pkMonth filter pushes predicate into the view — each source table can use its index
SELECT pkClient, SUM(RevenueZARMTD) AS revenue
FROM publish.Revenue WITH (NOLOCK)
WHERE pkMonth BETWEEN 733 AND 744    -- months for 2025 (look up from dim.Date first!)
GROUP BY pkClient

-- CORRECT: Use persistedView if available — it's a pre-materialized index
SELECT pkClient, SUM(RevenueZARMTD) AS revenue
FROM persistedView.[publish.Revenue] WITH (NOLOCK)   -- use search_catalog to verify exact name
WHERE pkMonth BETWEEN 733 AND 744
GROUP BY pkClient
```

### ✅ pkMonth lookup pattern

`pkMonth` in `publish.Revenue` corresponds to `pkDate` in `dim.Date`.
**Always resolve the pkMonth range before querying Revenue:**

```sql
-- Step 1: Resolve pkMonth values for the target period
SELECT MIN(pkDate) AS pkMonthFrom, MAX(pkDate) AS pkMonthTo
FROM dim.Date WITH (NOLOCK)
WHERE calYear = 2025

-- Step 2: Use those values as filters in publish.Revenue
SELECT TOP 20 pkClient, SUM(RevenueZARMTD) AS totalRevenue
FROM publish.Revenue WITH (NOLOCK)
WHERE pkMonth BETWEEN @pkMonthFrom AND @pkMonthTo
GROUP BY pkClient
ORDER BY totalRevenue DESC
```

### Key discovery rule: use catalog metadata, not view queries, for exploration

Before querying a large view:
1. `search_catalog(lineage='publish.Revenue')` — see all source tables and their filter conditions
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
2. **`publish.*` views** (248+) — business-ready star-schema joins; what BI tools query
3. **`persistedView.publish.*`** (292) — SQL Server indexed views materializing `publish.*`
4. **`audit.*` views** (9) — data quality monitors

When diagnosing slow ETL or long pipeline runs, the problem is often in **`publish.*` view definitions**:
- Duplicate JOINs to the same table (e.g., joining `dim.Client` twice)
- Joining through `publish.*` views inside other `publish.*` views (N-level view nesting)
- Joining `fact.*` tables without adequate WHERE predicates — they get full scans

Use `inspect_definition(object='publish.ViewName')` to read the T-SQL and detect these patterns.
Use `inspect_definition(depends_on='publish.ViewName')` to trace the full view chain.
Use `inspect_definition(search='TableName')` to find every view that joins a specific table.

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

Lineage maps for critical views like `publish.Revenue` and `publish.Balances` are stored as
structured data in the schema catalog — NOT in this file.

**To access lineage:**
- `search_catalog(lineage='publish.Revenue')` → full map: 59 source views, dimension joins, business areas
- `search_catalog(lineage='publish.Balances')` → full map: 10 source views, balance sheet categories

**What lineage tells you:**
- Which `publish.Mapping*` views feed into the critical view
- How sources are grouped by business area (RBB, UNO, CPA, Africa, IMEX, etc.)
- Which dimension tables join via pk* keys (dim.Client, dim.Product, etc.)
- Filter conditions applied to each source

**Use lineage for:**
- Tracing a revenue number to its source fact table
- Finding which business lines a client participates in
- Cross-sell analysis (products used vs. not used, compared to peer clients)
- Understanding what `inspect_definition` will reveal when drilling deeper

