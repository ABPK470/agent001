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

For ANY database question, follow this generic process:

1. **Identify the domain**: Use the schema descriptions above to determine which schema(s) are relevant.
   - Revenue/balances/clients → `publish`, `fact`, `dim`
   - Pipeline/ETL/jobs → `agent`, `core`
   - Data quality → `audit`, `gate`

2. **Find the tables**: Use `explore_mssql_schema(search='keyword')` to find tables/views matching your topic.
   Or use `explore_mssql_schema(schema='publish')` to list all tables in a schema.

3. **Discover columns**: Use `explore_mssql_schema(table='schema.TableName')` to get EXACT column names.
   Do this for EVERY table you plan to query. Never guess column names.

4. **Check for missing data**: If a table has an ID column but not the label/name you need,
   search for a related table in another schema that has both the ID and the name,
   then JOIN them.

5. **Test small first**: Run `SELECT TOP 5 ...` to verify the query works and data looks right.

6. **Scale up**: Only after confirming the shape, write the full query with filters and aggregations.
