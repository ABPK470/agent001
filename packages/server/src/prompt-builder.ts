/**
 * Prompt builder — constructs system-prompt sections for agent runs.
 *
 * Extracted from orchestrator.ts so the prompt logic is testable
 * and reusable independently of the run lifecycle.
 */

import {
    getCatalog,
    getCatalogPromptSummary,
    getDefaultMssqlConnectionName,
    getMssqlConfig,
    getTenantConfig,
    listExpensiveUnionViews,
    topNTables,
    topNUnionViews,
    type Tool,
} from "@mia/agent"
import { arch, homedir, platform } from "node:os"

// ── Environment detection ────────────────────────────────────────

const OS_LABELS: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
}

export function buildEnvironmentContext(opts?: { isAdmin?: boolean }): string {
  const isAdmin = opts?.isAdmin ?? false
  const os = OS_LABELS[platform()] ?? platform()
  const shell = platform() === "win32" ? "cmd.exe / PowerShell" : "/bin/sh (POSIX)"
  const lines = [
    "\nEnvironment:",
    `  OS: ${os} (${arch()})`,
    `  Shell: ${shell}`,
    // Home directory is the real server path — only expose to admin.
    ...(isAdmin ? [`  Home: ${homedir()}`] : []),
    `  Node: ${process.version}`,
  ]
  if (platform() === "darwin") {
    lines.push("  Note: macOS uses BSD coreutils (e.g. sed -i '' not sed -i, no GNU extensions by default).")
  } else if (platform() === "win32") {
    lines.push("  Note: Use PowerShell syntax or ensure commands are Windows-compatible.")
  }
  return lines.join("\n")
}

/**
 * Extract a compact header from a per-connection knowledge body.
 *
 * Used when `mssqlKnowledgeMode === "header"`: keeps the agent oriented
 * (it learns the schema namespaces exist, sees the lead-in paragraph)
 * without paying for the full 5-15 KB prose body on borderline goals.
 *
 * Heuristic: take the first non-blank paragraph (up to the first blank
 * line), then a one-line tail telling the agent how to discover more.
 * Capped at ~700 bytes either way.
 */
function extractKnowledgeHeader(body: string): string {
  const HEADER_BYTE_CAP = 700
  const firstPara = body.split(/\n\s*\n/, 1)[0]?.trim() ?? ""
  const truncated = firstPara.length > HEADER_BYTE_CAP
    ? firstPara.slice(0, HEADER_BYTE_CAP).replace(/\s+\S*$/, "") + "\u2026"
    : firstPara
  return `${truncated}\n[full knowledge body omitted — call search_catalog / inspect_definition / explore_mssql_schema for specifics]`
}

/**
 * Build capability context for tools that need ambient awareness in the prompt.
 * Tool definitions alone tell the LLM *how* to call a tool, but not *when* or *why*.
 * This injects discoverable capability summaries so the LLM knows what resources exist.
 *
 * The opts object lets the caller skip whole sub-sections to keep token budget
 * tight when the current goal does not need them. Defaults preserve the
 * pre-Phase-2 behaviour for any caller (incl. tests) that still passes only
 * `tools`.
 */
export interface BuildToolContextOptions {
  /** Include the MSSQL knowledge body (large — typically the biggest single win). */
  includeMssqlKnowledge?: boolean
  /**
   * Granularity for the knowledge body when `includeMssqlKnowledge` is true.
   *  - "full"   — full per-connection knowledge file (default).
   *  - "header" — first paragraph + namespace summary + discovery-tools hint
   *               (~600B). Used for borderline DB-intent goals.
   */
  mssqlKnowledgeMode?:    "full" | "header"
  /** Include the live schema-catalog summary (medium). */
  includeMssqlCatalog?:   boolean
  /** Include the verbose "RULES / EFFICIENCY ANALYSIS" guidance (large). */
  includeMssqlGuidance?:  boolean
}

/**
 * Concrete example tokens derived from the live catalog so the static
 * guidance text never names a customer-specific table. When the catalog
 * has no qualifying object, each placeholder degrades to generic shape
 * language. Cheap to recompute per prompt build.
 */
interface CatalogExamples {
  exampleWideView:     string
  schemaList:          string
  dbSizeHint:          string
  mirrorAdvice:        string
  mirrorInspectAdvice: string
  dimensionAdvice:     string
}

function catalogExamples(): CatalogExamples {
  const catalog = getCatalog(getDefaultMssqlConnectionName() ?? "default")
  const tenant  = getTenantConfig()

  // Best wide-union view to use as a worked lineage example.
  let exampleWideView = "<wide-union-view>"
  const wideViews = catalog ? [...listExpensiveUnionViews({ accessor: () => catalog })] : []
  if (wideViews.length > 0) {
    wideViews.sort((a, b) => b[1] - a[1])
    exampleWideView = wideViews[0]![0]
  } else if (catalog) {
    const v = topNUnionViews(1, { accessor: () => catalog })[0]
    if (v) exampleWideView = v.table.qualifiedName
  }

  // List of schemas the agent might bump into when scoping list-of-name
  // queries — rendered as a short, prefix-sample of catalog schemas.
  let schemaList = "<various schemas>"
  if (catalog) {
    const schemas = new Set<string>()
    for (const [, t] of catalog.tables) schemas.add(t.schema)
    const sample = [...schemas].slice(0, 4).map((s) => `${s}.*`)
    if (sample.length > 0) schemaList = sample.join(", ")
  }

  // Approximate DB size from the largest table's row count.
  let dbSizeHint = "very large"
  if (catalog) {
    const top = topNTables(1, { accessor: () => catalog })[0]
    if (top?.rowCount != null) {
      const n = top.rowCount
      dbSizeHint = n >= 1e9 ? "multi-TB" : n >= 1e8 ? "100s of GB" : n >= 1e6 ? "GB-scale" : "moderate"
    }
  }

  // Mirror-schema advice depends on tenant.mirrorSchema being set.
  const mirrorAdvice = tenant.mirrorSchema
    ? `  • prefer ${tenant.mirrorSchema}.X over the source view when it exists — same data, pre-materialized.`
    : "  • prefer pre-materialized mirrors over expensive views when the catalog exposes them."
  const mirrorInspectAdvice = tenant.mirrorSchema
    ? `    For ${tenant.mirrorSchema} objects use 3-part form: inspect_definition(object='${tenant.mirrorSchema}.<schema>.<view>')`
    : "    For mirrored objects use the curated 3-part form when one is defined."

  // Pick the two largest dimension-style tables (heuristic: rowCount-ranked
  // tables in schemas with negative routing weight or named like dim/lookup).
  let dimensionAdvice = "  • Before any JOIN to a high-cardinality dimension: confirm cardinality with profile_data first."
  if (catalog) {
    const top = topNTables(10, { accessor: () => catalog })
    const dims = top.filter((t) => /^(dim|lookup|ref|master)/i.test(t.schema)).slice(0, 2)
    if (dims.length >= 2) {
      dimensionAdvice = `  • Before any JOIN to ${dims[0]!.qualifiedName} or ${dims[1]!.qualifiedName}: confirm cardinality with profile_data first.`
    } else if (dims.length === 1) {
      dimensionAdvice = `  • Before any JOIN to ${dims[0]!.qualifiedName}: confirm cardinality with profile_data first.`
    }
  }

  return { exampleWideView, schemaList, dbSizeHint, mirrorAdvice, mirrorInspectAdvice, dimensionAdvice }
}

export function buildToolContext(tools: Tool[], opts?: BuildToolContextOptions): string {
  const includeMssqlKnowledge = opts?.includeMssqlKnowledge ?? true
  const mssqlKnowledgeMode    = opts?.mssqlKnowledgeMode    ?? "full"
  const includeMssqlCatalog   = opts?.includeMssqlCatalog   ?? true
  const includeMssqlGuidance  = opts?.includeMssqlGuidance  ?? true

  // Catalog-derived example placeholders so guidance text never names a
  // customer-specific table. All placeholders fall back to generic shape
  // language when the catalog has no qualifying object.
  const ex = catalogExamples()
  const sections: string[] = []

  const hasMssql = tools.some((t) =>
    t.name === "query_mssql" || t.name === "explore_mssql_schema" ||
    t.name === "discover_relationships" || t.name === "profile_data" ||
    t.name === "inspect_definition" || t.name === "search_catalog",
  )
  if (hasMssql) {
    const cfgs = getMssqlConfig()
    if (cfgs.length > 0) {
      const dbList = cfgs.map((c) => {
        const mode = c.writeEnabled ? "read-write" : "read-only"
        return cfgs.length === 1
          ? `${mode} access to ${c.server}/${c.database}`
          : `"${c.name}" (${c.server}/${c.database}, ${mode})`
      }).join("; ")
      sections.push(`Database: You have access to Microsoft SQL Server — ${dbList}.`)

      // In multi-connection mode, tell the agent which connection is "home"
      // so it never has to guess. The default is used for all DB queries unless
      // the task explicitly requires a different environment (e.g. sync operations).
      if (cfgs.length > 1) {
        const defaultConnName = getDefaultMssqlConnectionName()
          ?? cfgs[0].name  // mirrors getPool() fallback
        sections.push(
          `Default connection: "${defaultConnName}" — use this for all regular database queries.`,
          `DO NOT pass environment names (${cfgs.map((c) => `"${c.name}"`).join(", ")}) as the "database" parameter — that runs USE [name] as SQL and will fail.`,
          `To target a different server, pass connection='name' (not database='name').`,
        )
      }
    } else {
      sections.push(
        "Database: You have access to a Microsoft SQL Server database via the query_mssql and explore_mssql_schema tools.",
      )
    }

    // Inject database knowledge (schema descriptions, business context)
    // loaded from knowledgePath files at startup. Multiple connections
    // typically point at the same `knowledgePath` (uat + prod usually
    // describe the same database family), so we content-hash and emit
    // each unique body exactly once with a header listing every env
    // it covers. This is the single biggest per-call token win — see
    // /memories/session/plan.md (Phase 1).
    //
    // `mssqlKnowledgeMode` (set by decideSections from the goal score)
    // chooses full body vs header-only. Header mode keeps the agent
    // oriented (it learns the schema namespaces exist) without paying
    // 5-15 KB per call for goals that only marginally touch the DB.
    if (includeMssqlKnowledge && cfgs.some((c) => c.knowledge)) {
      const groups = new Map<string, string[]>()  // body → [env names]
      for (const c of cfgs) {
        if (!c.knowledge) continue
        const arr = groups.get(c.knowledge) ?? []
        arr.push(c.name)
        groups.set(c.knowledge, arr)
      }
      const knowledgeBlocks: string[] = []
      for (const [body, envs] of groups) {
        const renderedBody = mssqlKnowledgeMode === "header"
          ? extractKnowledgeHeader(body)
          : body
        knowledgeBlocks.push(
          cfgs.length === 1 || (groups.size === 1 && envs.length === cfgs.length)
            ? renderedBody
            : `[${envs.join(", ")}]\n${renderedBody}`,
        )
      }
      const header = mssqlKnowledgeMode === "header"
        ? "DATABASE KNOWLEDGE (header only — goal looks marginally DB-shaped; full body omitted for prompt economy. Call search_catalog / explore_mssql_schema / inspect_definition for details):"
        : "DATABASE KNOWLEDGE — use this to understand the database structure and write accurate queries:"
      sections.push("", header, ...knowledgeBlocks)
    }

    // Inject live catalog summary if available
    if (includeMssqlCatalog) {
      const catalogSummary = getCatalogPromptSummary()
      if (catalogSummary) {
        sections.push("", "SCHEMA CATALOG (live, auto-built at startup from sys.* DMVs):", catalogSummary)
      }
    }

    if (includeMssqlGuidance) {
      sections.push(
        "",
        "SCALE CONTEXT:",
        `  • ~${ex.dbSizeHint} database. ALWAYS use TOP + date filter on large fact/archive tables.`,
        "  • NEVER SELECT * or COUNT(*) without a WHERE clause on large tables.",
        ex.mirrorAdvice,
        ex.dimensionAdvice,
        "  • Multi-large-object joins: see the BIG-TABLE / MICRO-ETL section above for the canonical #temp staging pattern. Single-shot multi-join SELECTs against billion-row tables time out.",
        "",
        "T-SQL DIALECT:",
        "  • Target is Microsoft SQL Server. NOT supported: QUALIFY, LIMIT, ILIKE, ::, DATE_TRUNC, INTERVAL, EXTRACT, backticks.",
        "  • Use: TOP n / OFFSET-FETCH, LIKE, CAST(x AS type), DATEADD/DATEDIFF/DATEPART, [brackets].",
        "  • MIN/MAX/SUM/AVG fail on bit columns — wrap as SUM(CAST(col AS int)).",
        "",
        "DATA TOOLS — use in this order:",
        "  0. search_catalog  ★ START HERE. Keyword search over the column index + FK graph. Zero SQL queries.",
        "                       Modes: search, table, column, joins, path, lineage, stats, refresh.",
        "                       search_catalog(search='keyword', schema='<schema>') → scope results to one schema.",
        `                       search_catalog(lineage='${ex.exampleWideView}') → full source dependency map.`,
        "                       search_catalog(stats=true) → largest UNION views ranked by source-table rows (pre-computed at startup).",
        "                         Use this as the entry point when asked to find large views or duplicate joins.",
        "  1. explore_mssql_schema  — exact columns. ONLY after search_catalog identified the table.",
        "  2. inspect_definition    — T-SQL source, detects duplicate joins, traces dependencies.",
        "  3. discover_relationships — FK graph traversal, implicit column matches, join paths.",
        "  4. profile_data           — cardinality, nulls, top values. Run before every JOIN.",
        "  5. query_mssql            — SELECT TOP 5 first; full query only after shape is confirmed.",
        "",
        "RULES (non-negotiable):",
        "  • NEVER skip search_catalog. NEVER guess a table name. NEVER dump entire schemas.",
        "  • explore_mssql_schema(schema='...') to browse is an ANTI-PATTERN — search first.",
        "  • Schema-qualify everything: schema.table. No bare names.",
        "  • Fix errors immediately — read the SQL error, don't retry the same broken query.",
        "",
        "EFFICIENCY ANALYSIS — when asked about slow pipelines, duplicate joins, or unexpected runtimes:",
        "  • To find which views are largest / have duplicate joins:",
        "      1. search_catalog(stats=true) → 'Largest VIEWS' section gives the ranked list",
        "      2. inspect_definition(object='<schema>.X') IN PARALLEL on each — any table in FROM/JOIN twice = duplicate join",
        "      'Largest tables' in stats output = physical tables, not views. Ignore for this task.",
        "  • COUNTING duplicate joins across many objects (e.g. 'how many of N datasets have duplicate joins?'):",
        "      PREFERRED — let the tool source the names itself in ONE call:",
        "        inspect_definition(scan_duplicates=true, names_query=\"SELECT name FROM <metadata.Table>\")",
        "      Alternatives: names='schema.A,schema.B,...' (when you already have a small list),",
        "      or schema='X' (ONLY when the user truly means 'objects defined in schema X').",
        "      WARNING — scope mismatch is the #1 failure mode here:",
        "        schema='<metaSchema>' scans only objects DEFINED in that schema (typically a handful of metadata views).",
        "        It is NOT the same as 'all rows of <metaSchema>.Dataset.name' — those names span MANY",
        `        schemas (${ex.schemaList}). When the user references a list`,
        "        stored in a table, you MUST use names_query=, NEVER schema=.",
        "  • inspect_definition(object='schema.view') → T-SQL source for a specific known view.",
        ex.mirrorInspectAdvice,
        "  • inspect_definition(depends_on='view') → full dependency chain.",
        "  • inspect_definition(slow_queries=true) → most expensive live queries.",
        "  • inspect_definition(missing_indexes=true) → SQL Server's own index recommendations.",
        "",
        "DATA DISPLAY: For any report/data-display task, query_mssql for rows, then write_file a STATIC HTML — no server/API layer.",
        "",
        "EXPORTING LARGE LISTS — when the user asks for ALL rows of something (e.g. \"give me all 4000 dataset names\", \"export the table\", \"save the results\"):",
        "  • Use export_query_to_file(query='SELECT ...', path='datasets.csv') — it streams the FULL result set to disk and returns only a 20-row preview.",
        "  • Do NOT use query_mssql + write_file for this purpose. The model will only retype ~20 rows and the file will be truncated.",
        "  • In your reply, acknowledge the file path + total row count, and quote the 20-row preview the tool returned. The user gets the full data via the file.",
        "  • Pick the file extension from intent: .csv for tabular, .txt for a single-column list, .jsonl for streaming JSON.",
      )
    }
  }

  if (sections.length === 0) return ""

  return "\nCapabilities:\n  " + sections.join("\n  ")
}

/**
 * Memory-context guidance — explains what the <working_memory>,
 * <episodic_memory> and <semantic_memory> XML tags mean and tells the
 * agent to reuse prior working approaches instead of rediscovering from
 * scratch. Call site decides when to include this (only emit when at
 * least one memory tier is actually present in the system messages,
 * otherwise it is ~30 lines of guidance for content that does not exist).
 */
export function buildMemoryGuidance(): string {
  return [
    "MEMORY CONTEXT — check before issuing discovery tool calls:",
    "  The system prompt may contain <working_memory>, <episodic_memory>, and <semantic_memory> blocks.",
    "  These are summaries of prior runs retrieved by relevance to the current goal.",
    "",
    "  • <episodic_memory>: summaries of prior runs for the same or similar goals.",
    "    If you see 'Status: completed' for a matching goal:",
    "    1. Extract the table names and column names that worked from the Answer section.",
    "    2. Use them directly — skip search_catalog and explore_mssql_schema for those tables.",
    "    3. Only call discovery tools for tables/columns NOT already confirmed in memory.",
    "    CRITICAL OVERRIDE: 'NEVER skip search_catalog' means never guess without evidence.",
    "    Memory IS evidence — a prior completed run already ran search_catalog for you.",
    "    Calling search_catalog again when episodic_memory already has the answer wastes",
    "    tokens and iterations. Skip it.",
    "",
    "  • <semantic_memory>: long-term consolidated facts from many prior runs.",
    "    Treat confirmed facts here (table names, column names, filter patterns) as trusted.",
    "",
    "  • <working_memory>: recent tool calls from the active session. Use for continuity.",
    "",
    "  RULE: Memory saves iterations. A prior completed run for the same goal = use its tool sequence.",
    "  Do NOT re-run the full discovery workflow if memory already shows what worked.",
    "",
    "  CRITICAL: Goal qualifiers are FILTERS, not schema pivots.",
    "    If the current goal adds a scope (e.g. 'in fact schema', 'for client X') to a memory match,",
    "    apply that qualifier as a filter on the SAME tables/tools from memory — do not switch schemas.",
    "",
    "  TERMINOLOGY DISAMBIGUATION:",
    "    'datasets' in questions refers to core.Dataset / core.vDataset (ETL metadata objects).",
    "    It does NOT mean the 'fact' schema. 'fact schema' and 'datasets' are different things.",
    "    Example: 'duplicate joins in datasets in fact schema' = look in core.vDataset filtered to fact schema rows.",
    "    Example: 'how many datasets have duplicate joins?' = ONE call:",
    "      inspect_definition(scan_duplicates=true, names_query=\"SELECT name FROM core.Dataset\")",
    "      The tool runs the SELECT internally and scans every returned name.",
    "      Do NOT use schema='core' here — that scans only the 39 metadata-schema views,",
    "      not the 4262 dataset entries (which span many schemas).",
    "      Do NOT delegate this — it would require 4000+ child iterations.",
    "",
    "  WRITING TO MEMORY — the `note` tool:",
    "    When you DISCOVER or CONFIRM a fact about the schema or data that future",
    "    turns would need (a join key, a column's aggregation semantics, a grain,",
    "    a date range, a known-good filter), call `note` with subject = the",
    "    qualified name (e.g. '<schema>.<Table>.<Column>') and claim = the",
    "    fact in one sentence. These notes are saved to working memory and",
    "    retrieved into your next turn, so you don't re-discover the same fact.",
    "    Call `note` ONCE per discovery — duplicates are dropped automatically.",
  ].join("\n")
}

/**
 * Generate a shallow workspace tree for system prompt context.
 */
export async function getWorkspaceContext(workspace: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    const { stdout } = await exec("find", [
      ".", "-maxdepth", "3", "-type", "d",
      "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/.git/*",
      "-not", "-path", "*/dist/*",
    ], { cwd: workspace, timeout: 5000 })
    const dirs = stdout.trim().split("\n").filter(Boolean).slice(0, 60)
    return `Structure:\n${dirs.join("\n")}`
  } catch {
    return ""
  }
}

/**
 * Hosted-profile runtime context. Replaces the developer-mode workspace tree
 * dump for hosted runs: the agent is told it has a private sandbox directory,
 * the OS family of the host, the shell available inside the sandbox, and the
 * MSSQL environment defaults — but never the real application source layout.
 *
 * The exact sandbox path basename is included so log lines and tool errors
 * are correlatable, but the absolute parent path is not exposed.
 */
export function buildHostedRuntimeContext(opts: {
  sandboxRoot:           string
  defaultDbEnvironment?: "dev" | "uat" | "prod"
}): string {
  const os = OS_LABELS[platform()] ?? platform()
  const shell = platform() === "win32" ? "cmd.exe" : "/bin/sh"
  const sandboxName = opts.sandboxRoot.split(/[/\\]/).pop() ?? "sandbox"
  const lines = [
    "Hosted runtime:",
    `  Host OS:       ${os} (${arch()})`,
    `  Sandbox shell: ${shell}`,
    `  Sandbox root:  sandbox://${sandboxName}/   (private; outside the app source tree)`,
    "  Filesystem:    file tools see only the sandbox; references to a real app workspace are not available.",
    "  Network:       outbound HTTP requires explicit approval; MSSQL access is via dedicated tools.",
  ]
  if (opts.defaultDbEnvironment) {
    lines.push(`  DB default:    ${opts.defaultDbEnvironment.toUpperCase()} environment.`)
  }
  lines.push(
    "  DB defaults:   UAT and PROD are read-only; DML/DDL is blocked unless explicitly configured.",
    "  Output:        files written inside the sandbox can be promoted to the user via the dedicated promotion flow.",
  )
  return lines.join("\n")
}
