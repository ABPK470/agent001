Big-table query discipline (this is what separates a real ETL engineer from a tourist):

**Performance budget: 2 minutes. HARD.** Queries that don't return in 120 s are killed and produce nothing. Don't write hopeful SQL — design every statement to finish well under that. The bar is **10/10 correctness, 10/10 performance** — not "it ran". If you're unsure of the row count, `profile_data` first.

Reality of the warehouse:
- 100M–2B-row tables/views. `publish.Revenue` and `publish.Balances` are UNION views over 10–60 fact tables; `fact.UnoTranspose` ~2.4B; `dim.Client` ~26M; `dim.Account` ~51M.
- Every touch of a UNION view scans every branch. **Touch each big view ≤ 2× per task — never once per output column.**

Allowed mutations on local `#temp` tables only: `CREATE TABLE`, `SELECT … INTO`, `INSERT`, `UPDATE`, `DELETE`, `CREATE INDEX`, `TRUNCATE`, `DROP`, `MERGE`. Real tables / views / indexes / `sys.*` / `##global` temps are READ-ONLY — the tool guard rejects mutations on them with a clear error.

**MANDATORY `#temp` naming — collisions are real:**
- Connection pooling re-uses SPIDs. A leftover `#range` from another run will fail your `CREATE TABLE` with *"There is already an object named '#range' in the database"*.
- Every `#temp` name MUST end with an 8-hex-char random suffix that **you generate when you write the query** (SQL can't interpolate it without dynamic SQL — pick it yourself, e.g. `a3f91c08`). Pattern: `#<purpose>_<8hex>`. Use the **same** suffix across all temps in one batch so cleanup is grouped.
- Always `DROP TABLE` every temp at the end. If a query can fail mid-batch, structure cleanup so leftover temps don't poison the next run.

**The Two-Stage Pattern — non-negotiable for big-view work:**

1. **STAGE 1 — narrow the keys.** Pull only the small dim keys + ranking metric from the big view, with the date/region filter applied. Output: tiny `#keys` table (≤ 1 000 rows). One touch of the big view.
2. **STAGE 2 — fetch the detail rows for those keys.** `SELECT pkClient, pkProduct, pkAccount, pkMonth, <metric> INTO #detail … WHERE pkClient IN (SELECT pkClient FROM #keys)`. Output: a few thousand–few hundred K rows. **Second and last** touch of the big view.
3. **STAGE 3 — derive every output column from `#detail`.** Top product, distinct counts, sub-aggregates, dim joins for labels — all run against `#detail`, never the big view. Cheap.

Canonical micro-ETL pattern (top-N revenue clients with full enrichment, returns in seconds):

```sql
SET NOCOUNT ON;
-- suffix a3f91c08 — agent-generated 8-hex, used on every #temp in this batch

-- 1. Date range from the small dim, NOT the big view.
SELECT MIN(pkMonth) AS pkMonthFrom, MAX(pkMonth) AS pkMonthTo
INTO #range_a3f91c08
FROM dim.Date WITH (NOLOCK)
WHERE [Year] = 2025;

-- 2. STAGE 1 — top-N keys only. ONE touch of publish.Revenue.
SELECT TOP 5 r.pkClient, SUM(r.RevenueZARMTD) AS RevenueZAR
INTO #topClients_a3f91c08
FROM publish.Revenue r WITH (NOLOCK)
JOIN #range_a3f91c08 rg ON r.pkMonth BETWEEN rg.pkMonthFrom AND rg.pkMonthTo
WHERE r.pkClient IS NOT NULL
GROUP BY r.pkClient
ORDER BY SUM(r.RevenueZARMTD) DESC;

-- 3. STAGE 2 — detail rows for those 5 keys ONLY. SECOND and LAST touch of publish.Revenue.
SELECT r.pkClient, r.pkProduct, r.pkAccount, r.pkMonth, r.RevenueZARMTD
INTO #revLines_a3f91c08
FROM publish.Revenue r WITH (NOLOCK)
JOIN #range_a3f91c08 rg ON r.pkMonth BETWEEN rg.pkMonthFrom AND rg.pkMonthTo
WHERE r.pkClient IN (SELECT pkClient FROM #topClients_a3f91c08);

-- Index ONLY because we'll probe this >2× downstream and it's > a few thousand rows.
CREATE INDEX ix_revLines_a3f91c08 ON #revLines_a3f91c08 (pkClient, pkProduct);

-- (Same pattern for publish.Balances if you need balance metrics:
--   SELECT … INTO #balLines_a3f91c08 … WHERE pkClient IN (SELECT pkClient FROM #topClients_a3f91c08))

-- 4. STAGE 3 — every output column derived from #revLines + dims. NO big-view touches here.
SELECT
    tc.pkClient,
    c.ClientName,
    CAST(tc.RevenueZAR AS decimal(18,2))                                                               AS TotalRevenueZAR,
    (SELECT COUNT(DISTINCT pkProduct) FROM #revLines_a3f91c08 WHERE pkClient = tc.pkClient)             AS DistinctProducts,
    (SELECT COUNT(DISTINCT pkAccount) FROM #revLines_a3f91c08
       WHERE pkClient = tc.pkClient AND pkAccount IS NOT NULL)                                          AS DistinctAccounts,
    rp.ProductName                                                                                      AS TopRevenueProduct
FROM #topClients_a3f91c08 tc
LEFT JOIN publish.Client c WITH (NOLOCK) ON c.pkClient = tc.pkClient
OUTER APPLY (
    SELECT TOP 1 p.Name AS ProductName
    FROM #revLines_a3f91c08 rl                       -- against the #temp, NEVER the big view
    LEFT JOIN publish.Product p WITH (NOLOCK) ON p.pkProduct = rl.pkProduct
    WHERE rl.pkClient = tc.pkClient
    GROUP BY p.Name
    ORDER BY SUM(rl.RevenueZARMTD) DESC, p.Name      -- deterministic tiebreaker
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
- `COUNT(DISTINCT)` against a big view — always against a staged `#temp`, never the original.
- `SUM(<column called Average… / Mean… / Spot… / EOM…>)` — summing point-in-time or averaged values is mathematically wrong. Read the column name; use `AVG` or pick a single `pkMonth` instead.
- Indexing a tiny staging (<10 K rows) — pure cargo-cult. Index a `#temp` only when it has ≥ 10 K rows AND will be probed ≥ 2× downstream.
- Reusing temp names like `#range`, `#tmp`, `#data`, `#topClients` across runs — collisions on pooled SPIDs. Always append the unique 8-hex suffix.
- `TOP n … ORDER BY <agg> DESC` without a secondary tiebreaker — non-deterministic on ties.

Pre-flight correctness checklist (run mentally before submitting any big-view query):
1. Does each big view (`publish.Revenue`, `publish.Balances`, `fact.*`) appear ≤ 2× across the whole batch? If not, redesign Stage 2.
2. Are aggregates type- and semantically-correct? (`SUM(CAST(bit AS int))`, `AVG(<MonthlyAverage>)` not `SUM`, deterministic `ORDER BY` on `TOP N`.)
3. Does every `#temp` carry the unique 8-hex suffix, and is every one `DROP`ped at the end?
4. Did I resolve date keys via `dim.Date`, not the big view?
