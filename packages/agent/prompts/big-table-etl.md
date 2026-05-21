Big-table query discipline:

**Performance budget: 2 minutes. HARD.** Queries that do not return in 120 s are killed. If unsure of row count, `profile_data` first.

Reality of the warehouse:
- 100M–2B-row tables/views. `publish.Revenue` and `publish.Balances` are UNION views over 10–60 fact tables; `fact.UnoTranspose` ~2.4B; `dim.Client` ~26M; `dim.Account` ~51M.
- Every touch of a UNION view scans every branch. **Touch each big view ≤ 2× per task.**
- Prefer `persistedView.[publish.X]` over `publish.X` for heavy reads when the mirror exists.

Allowed mutations on local `#temp` tables only: `CREATE TABLE`, `SELECT … INTO`, `INSERT`, `UPDATE`, `DELETE`, `CREATE INDEX`, `TRUNCATE`, `DROP`, `MERGE`. Real tables / views / indexes / `sys.*` / `##global` temps are READ-ONLY — the tool guard rejects mutations on them with a clear error.

**MANDATORY `#temp` naming — collisions are real:**
- Connection pooling re-uses SPIDs. A leftover `#range` from another run will fail your `CREATE TABLE` with *"There is already an object named '#range' in the database"*.
- Every `#temp` name MUST end with an agent-chosen 8-hex suffix, e.g. `#range_a3f91c08`. Use the **same** suffix across the whole batch.
- Always `DROP TABLE` every temp at the end. If a query can fail mid-batch, structure cleanup so leftover temps don't poison the next run.

**Mechanical self-check before you emit SQL — mandatory:**
- Do a literal find-all on every `#temp` token. Referenced temps must equal created temps plus final `DROP`s. One-character drift is a hard failure.
- There must be exactly **one** 8-hex suffix across the batch.
- If any large object (`publish.Revenue`, `publish.Balances`, `fact.*`) appears more than **2×** in the SQL text, rewrite into Stage 1 + Stage 2 + Stage 3.
- For `Average / Avg / Spot / EOM / Latest / Snapshot / MTD / YTD` columns, verify the math. Usually use `AVG(...)` or the latest row, not `SUM(...)`.

**The Two-Stage Pattern — non-negotiable for big-view work:**

1. **STAGE 1 — narrow the keys.** Pull only the small dim keys + ranking metric from the big view, with the date/region filter applied. Output: tiny `#keys` table (≤ 1 000 rows). One touch of the big view.
2. **STAGE 2 — fetch the detail rows for those keys.** `SELECT pkClient, pkProduct, pkAccount, pkMonth, <metric> INTO #detail … WHERE pkClient IN (SELECT pkClient FROM #keys)`. Output: a few thousand–few hundred K rows. **Second and last** touch of the big view.
3. **STAGE 3 — derive every output column from `#detail`.** Pre-aggregate once per key, then join the small grouped result.

Canonical micro-ETL pattern:

```sql
SET NOCOUNT ON;
-- suffix a3f91c08 — agent-generated 8-hex, used on every #temp in this batch

-- 1. Date range from the small dim, NOT the big view.
SELECT MIN(pkMonth) AS pkMonthFrom, MAX(pkMonth) AS pkMonthTo
INTO #range_a3f91c08
FROM dim.Date WITH (NOLOCK)
WHERE [Year] = 2025;

-- 2. STAGE 1 — top-N keys only. ONE touch.
SELECT TOP 5 r.pkClient, SUM(r.RevenueZARMTD) AS RevenueZAR
INTO #topClients_a3f91c08
FROM persistedView.[publish.Revenue] r WITH (NOLOCK)
JOIN #range_a3f91c08 rg ON r.pkMonth BETWEEN rg.pkMonthFrom AND rg.pkMonthTo
WHERE r.pkClient IS NOT NULL
GROUP BY r.pkClient
ORDER BY SUM(r.RevenueZARMTD) DESC;

-- 3. STAGE 2 — detail rows for those 5 keys ONLY. SECOND and LAST touch.
SELECT r.pkClient, r.pkProduct, r.pkAccount, r.pkMonth, r.RevenueZARMTD
INTO #revLines_a3f91c08
FROM persistedView.[publish.Revenue] r WITH (NOLOCK)
JOIN #range_a3f91c08 rg ON r.pkMonth BETWEEN rg.pkMonthFrom AND rg.pkMonthTo
WHERE r.pkClient IN (SELECT pkClient FROM #topClients_a3f91c08);

-- Index ONLY because we'll probe this >2× downstream and it's > a few thousand rows.
CREATE INDEX ix_revLines_a3f91c08 ON #revLines_a3f91c08 (pkClient, pkProduct);

-- (Same pattern for persistedView.[publish.Balances] if you need balance metrics:
--   SELECT … INTO #balLines_a3f91c08 … WHERE pkClient IN (SELECT pkClient FROM #topClients_a3f91c08))

-- 4. STAGE 3 — aggregate once, then join small results.
WITH revAgg AS (
    SELECT
        pkClient,
        COUNT(DISTINCT pkProduct) AS DistinctProducts,
        COUNT(DISTINCT pkAccount) AS DistinctAccounts
    FROM #revLines_a3f91c08
    GROUP BY pkClient
)
SELECT
    tc.pkClient,
    c.ClientName,
    CAST(tc.RevenueZAR AS decimal(18,2)) AS TotalRevenueZAR,
    ra.DistinctProducts,
    ra.DistinctAccounts,
    rp.ProductName AS TopRevenueProduct
FROM #topClients_a3f91c08 tc
LEFT JOIN publish.Client c WITH (NOLOCK) ON c.pkClient = tc.pkClient
LEFT JOIN revAgg ra ON ra.pkClient = tc.pkClient
OUTER APPLY (
    SELECT TOP 1 p.Name AS ProductName
    FROM #revLines_a3f91c08 rl
    LEFT JOIN publish.Product p WITH (NOLOCK) ON p.pkProduct = rl.pkProduct
    WHERE rl.pkClient = tc.pkClient
    GROUP BY p.Name
    ORDER BY SUM(rl.RevenueZARMTD) DESC, p.Name
) rp
ORDER BY tc.RevenueZAR DESC;

-- 5. Cleanup — every temp by suffix.
DROP TABLE #revLines_a3f91c08;
DROP TABLE #topClients_a3f91c08;
DROP TABLE #range_a3f91c08;
```

Anti-patterns — each one is a "this won't return in 2 min" smell:
- A mega-CTE joining `publish.Revenue` to `dim.Client` to `dim.Date` to `fact.RWA` in one statement.
- `SELECT TOP n … FROM publish.Revenue ORDER BY x` with no WHERE — full sort over every UNION branch.
- `MIN(pkMonth) FROM publish.Revenue` — full scan of every UNION branch. Use `dim.Date`.
- **Re-querying a big view inside `OUTER APPLY` per output column.** Computing top product, distinct products, distinct accounts as three OUTER APPLYs against `publish.Revenue` scans it 3× and times out. Stage detail rows ONCE (Stage 2) and derive everything from the staging.
- **Repeated scalar subqueries against the same `#detail` temp.** If Stage 3 asks for 3-5 metrics from `#revLines` or `#balLines`, group once by `pkClient` and join that small aggregate result instead of probing the temp repeatedly.
- `COUNT(DISTINCT)` against a big view — always against a staged `#temp`, never the original.
- `SUM(<column called Average… / Mean… / Spot… / EOM…>)` — summing point-in-time or averaged values is mathematically wrong. Read the column name; use `AVG` or pick a single `pkMonth` instead.
- Indexing a tiny staging (<10 K rows) — cargo-cult. Index a `#temp` only when it has ≥ 10 K rows AND will be probed ≥ 2× downstream.
- Reusing temp names like `#range`, `#tmp`, `#data`, `#topClients` across runs — collisions on pooled SPIDs. Always append the unique 8-hex suffix.
- `TOP n … ORDER BY <agg> DESC` without a secondary tiebreaker — non-deterministic on ties.

Pre-flight correctness checklist (run mentally before submitting any big-view query):
1. Does each big view (`publish.Revenue`, `publish.Balances`, `fact.*`) appear ≤ 2× across the whole batch? If not, redesign Stage 2.
2. Are aggregates type- and semantically-correct? (`SUM(CAST(bit AS int))`, `AVG(<MonthlyAverage>)` not `SUM`, deterministic `ORDER BY` on `TOP N`.)
3. Does every `#temp` carry the unique 8-hex suffix, and is every one `DROP`ped at the end?
4. Did I resolve date keys via `dim.Date`, not the big view?
