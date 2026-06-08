Big-table query discipline:

**Performance budget: 2 minutes. HARD.** 120s timeout. `profile_data` defaults to `mode='fast'` (metadata-only, sub-second, safe ANY size — including UNION big views) — use as FIRST move. `mode='deep'` scans; refused on big wide views (e.g. `{{wideUnionView}}` / `{{wideUnionView2}}` / `{{biggestFact}}`) — small tables / `#temp` only.

Reality of the warehouse:

- 100M–2B-row tables/views. `{{wideUnionView}}` and `{{wideUnionView2}}` are wide UNION views over many source branches ({{wideUnionViewBranches}}+ for the largest); `{{biggestFact}}` is the largest single fact; `{{centralDim}}`, `{{centralDim2}}` the most-referenced dimensions.
- Every touch of a UNION view scans every branch. **Touch each big view ≤ 2× per task.**
- Prefer the persisted mirror `{{mirrorSchema}}.[{{wideUnionView}}]` over `{{wideUnionView}}` for heavy reads when that exact mirror exists.

Allowed mutations on local `#temp` only: `CREATE TABLE`, `SELECT … INTO`, `INSERT`, `UPDATE`, `DELETE`, `CREATE INDEX`, `TRUNCATE`, `DROP`, `MERGE`. Real tables / views / indexes / `sys.*` / `##global` temps are READ-ONLY — the tool guard rejects mutations on them.

The tool validator enforces the structural rules (8-hex suffix discipline, single-suffix-per-batch, large-object ≤ 2 references, aggregate ↔ alias agreement, repeated-scalar-subquery on `#temp` block). Doctrine summaries above carry the citable rule bodies. Do not re-state them — just comply.

**The Two-Stage Pattern — non-negotiable for big-view work:**

1. **STAGE 1 — narrow the keys.** Pull only the small dim keys + ranking metric from the big view, with the date/region filter applied. Output: tiny `#keys` table (≤ 1 000 rows). One touch of the big view.
2. **STAGE 2 — fetch the detail rows for those keys.** `SELECT <entityKey>, <subKey>, <dateKey>, <metric> INTO #detail … WHERE <entityKey> IN (SELECT <entityKey> FROM #keys)`. Output: a few thousand–few hundred K rows. **Second and last** touch of the big view.
3. **STAGE 3 — derive every output column from `#detail`.** Pre-aggregate once per key, then join the small grouped result.

Canonical micro-ETL pattern (skeleton — `{{keyColumnExample}}`, `{{dateKeyExample}}`, `<MetricColumn>` are placeholders this deployment resolves from the catalog):

```sql
SET NOCOUNT ON;
-- suffix a3f91c08 — agent-generated 8-hex, used on every #temp in this batch

-- 1. Date range from the small calendar dim, NOT the big view.
SELECT MIN({{dateKeyExample}}) AS DateFrom, MAX({{dateKeyExample}}) AS DateTo
INTO #range_a3f91c08
FROM {{calendarDim}} WITH (NOLOCK)
WHERE [Year] = 2025;

-- 2. STAGE 1 — top-N keys only. ONE touch.
-- Prefer the persisted mirror `{{mirrorSchema}}.[{{wideUnionView}}]` when it
-- exists. Otherwise aggregate inside each source branch first, UNION the
-- branch-local aggregates, then rank. `{{branchExample}}` / `{{branchExample2}}`
-- below are real branches of `{{wideUnionView}}` resolved from this deployment's
-- catalog — substitute the branches relevant to the business question.
SELECT TOP 5 x.{{keyColumnExample}}, SUM(x.<MetricColumn>) AS <MetricColumn>
INTO #topEntities_a3f91c08
FROM (
        SELECT {{keyColumnExample}}, SUM(<MetricMTDColumn>) AS <MetricColumn>
        FROM {{branchExample}} WITH (NOLOCK)
        WHERE {{dateKeyExample}} BETWEEN (SELECT DateFrom FROM #range_a3f91c08)
                                     AND (SELECT DateTo   FROM #range_a3f91c08)
            AND {{keyColumnExample}} IS NOT NULL
        GROUP BY {{keyColumnExample}}

        UNION ALL

        SELECT {{keyColumnExample}}, SUM(<MetricMTDColumn>) AS <MetricColumn>
        FROM {{branchExample2}} WITH (NOLOCK)
        WHERE {{dateKeyExample}} BETWEEN (SELECT DateFrom FROM #range_a3f91c08)
                                     AND (SELECT DateTo   FROM #range_a3f91c08)
            AND {{keyColumnExample}} IS NOT NULL
        GROUP BY {{keyColumnExample}}

        -- repeat for the required source branches
) x
GROUP BY x.{{keyColumnExample}}
ORDER BY SUM(x.<MetricColumn>) DESC, x.{{keyColumnExample}};

-- 3. STAGE 2 — detail rows for those 5 keys ONLY. SECOND and LAST touch.
SELECT r.{{keyColumnExample}}, r.<SubKey1>, r.<SubKey2>, r.{{dateKeyExample}}, r.<MetricMTDColumn>
INTO #detailLines_a3f91c08
FROM {{wideUnionView}} r WITH (NOLOCK)
JOIN #range_a3f91c08 rg ON r.{{dateKeyExample}} BETWEEN rg.DateFrom AND rg.DateTo
WHERE r.{{keyColumnExample}} IN (SELECT {{keyColumnExample}} FROM #topEntities_a3f91c08);

-- Index ONLY because we'll probe this >2× downstream and it's > a few thousand rows.
CREATE INDEX ix_detailLines_a3f91c08 ON #detailLines_a3f91c08 ({{keyColumnExample}}, <SubKey1>);

-- (Same pattern for `{{mirrorSchema}}.[{{wideUnionView2}}]` if you need a second
--  metric: SELECT … INTO #detailLines2_a3f91c08 …)

-- 4. STAGE 3 — aggregate once, then join small results.
WITH metricAgg AS (
    SELECT
        {{keyColumnExample}},
        COUNT(DISTINCT <SubKey1>) AS DistinctSubKey1,
        COUNT(DISTINCT <SubKey2>) AS DistinctSubKey2
    FROM #detailLines_a3f91c08
    GROUP BY {{keyColumnExample}}
)
SELECT
    te.{{keyColumnExample}},
    d.<NameColumn>,
    CAST(te.<MetricColumn> AS decimal(18,2)) AS Total<MetricColumn>,
    ma.DistinctSubKey1,
    ma.DistinctSubKey2,
    top1.<SubName> AS Top<SubName>
FROM #topEntities_a3f91c08 te
LEFT JOIN {{centralDim}} d WITH (NOLOCK) ON d.{{keyColumnExample}} = te.{{keyColumnExample}}
LEFT JOIN metricAgg ma ON ma.{{keyColumnExample}} = te.{{keyColumnExample}}
OUTER APPLY (
    SELECT TOP 1 sd.<NameColumn> AS <SubName>
    FROM #detailLines_a3f91c08 dl
    LEFT JOIN {{centralDim2}} sd WITH (NOLOCK) ON sd.<SubKey1> = dl.<SubKey1>
    WHERE dl.{{keyColumnExample}} = te.{{keyColumnExample}}
    GROUP BY sd.<NameColumn>
    ORDER BY SUM(dl.<MetricMTDColumn>) DESC, sd.<NameColumn>
) top1
ORDER BY te.<MetricColumn> DESC;

-- 5. Cleanup — every temp by suffix.
DROP TABLE #detailLines_a3f91c08;
DROP TABLE #topEntities_a3f91c08;
DROP TABLE #range_a3f91c08;
```

Anti-patterns — each one is a "this won't return in 2 min" smell:

- A mega-CTE joining `{{wideUnionView}}` to `{{centralDim}}` to `{{calendarDim}}` to `{{biggestFact}}` in one statement.
- `SELECT TOP n … FROM {{wideUnionView}} ORDER BY x` with no WHERE — full sort over every UNION branch.
- `MIN({{dateKeyExample}}) FROM {{wideUnionView}}` — full scan of every UNION branch. Use `{{calendarDim}}`.
- **Re-querying a big view inside `OUTER APPLY` per output column.** Computing top item, distinct sub-keys, distinct accounts as three OUTER APPLYs against `{{wideUnionView}}` scans it 3× and times out. Stage detail rows ONCE (Stage 2) and derive everything from the staging.
- **Repeated scalar subqueries against the same `#detail` temp.** If Stage 3 asks for 3-5 metrics from `#detailLines` or a second metric temp, group once by `{{keyColumnExample}}` and join that small aggregate result instead of probing the temp repeatedly.
- `COUNT(DISTINCT)` against a big view — always against a staged `#temp`, never the original.
- `SUM(<column called Average… / Mean… / Spot… / EOM…>)` — summing point-in-time or averaged values is mathematically wrong. Read the column name; use `AVG` or pick a single `{{dateKeyExample}}` instead.
- Indexing a tiny staging (<10 K rows) — cargo-cult. Index a `#temp` only when it has ≥ 10 K rows AND will be probed ≥ 2× downstream.
- Reusing temp names like `#range`, `#tmp`, `#data` across runs — collisions on pooled SPIDs. Always append the unique 8-hex suffix.
- `TOP n … ORDER BY <agg> DESC` without a secondary tiebreaker — non-deterministic on ties.
