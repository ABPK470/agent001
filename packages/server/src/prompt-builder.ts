/**
 * Prompt builder — constructs system-prompt sections for agent runs.
 *
 * Extracted from orchestrator.ts so the prompt logic is testable
 * and reusable independently of the run lifecycle.
 */

import { getCatalogPromptSummary, getMssqlConfig, type Tool } from "@agent001/agent"
import { arch, homedir, platform } from "node:os"

// ── Environment detection ────────────────────────────────────────

const OS_LABELS: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
}

export function buildEnvironmentContext(): string {
  const os = OS_LABELS[platform()] ?? platform()
  const shell = platform() === "win32" ? "cmd.exe / PowerShell" : "/bin/sh (POSIX)"
  const lines = [
    "\nEnvironment:",
    `  OS: ${os} (${arch()})`,
    `  Shell: ${shell}`,
    `  Home: ${homedir()}`,
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
 * Build capability context for tools that need ambient awareness in the prompt.
 * Tool definitions alone tell the LLM *how* to call a tool, but not *when* or *why*.
 * This injects discoverable capability summaries so the LLM knows what resources exist.
 */
export function buildToolContext(tools: Tool[]): string {
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
    } else {
      sections.push(
        "Database: You have access to a Microsoft SQL Server database via the query_mssql and explore_mssql_schema tools.",
      )
    }

    // Inject database knowledge (schema descriptions, business context)
    // loaded from knowledgePath files at startup. This gives the agent
    // deep understanding of the database without runtime discovery.
    const knowledgeBlocks = cfgs
      .filter((c) => c.knowledge)
      .map((c) => cfgs.length === 1 ? c.knowledge! : `[${c.name}]\n${c.knowledge!}`)
    if (knowledgeBlocks.length > 0) {
      sections.push("", "DATABASE KNOWLEDGE — use this to understand the database structure and write accurate queries:", ...knowledgeBlocks)
    }

    // Inject live catalog summary if available
    const catalogSummary = getCatalogPromptSummary()
    if (catalogSummary) {
      sections.push("", "SCHEMA CATALOG (live, auto-built at startup from sys.* DMVs):", catalogSummary)
    }

    sections.push(
      "",
      "⚠ SCALE CONTEXT — READ THIS FIRST:",
      "This database is approximately 2TB of data.",
      "SCALE RULES — ALWAYS ENFORCE:",
      "  A) NEVER SELECT * or COUNT(*) on any fact/ext/archive table without a WHERE clause.",
      "  B) ALWAYS use TOP + a date filter when exploring large tables.",
      "  C) prefer persistedView.publish.X over publish.X when it exists — same data, pre-materialized.",
      "  D) For profiling: call profile_data(columns=['col1','col2']) — never profile all columns on a wide table.",
      "  E) Before any JOIN to dim.Client or dim.Account, confirm cardinality with profile_data or SELECT TOP 5.",
      "",
      "DATA TOOLS (use in this order for any database task):",
      "  0. search_catalog        — ★ ALWAYS START HERE. Searches the persistent knowledge graph.",
      "                              Shows rich metadata per table: row count, column count, join edges, centrality.",
      "                              Use this to identify the correct table — don't guess, let the data tell you.",
      "                              Modes: search='keyword', table='schema.Table', column='colName', joins='schema.Table', path=['A','B'], stats=true.",
      "  1. explore_mssql_schema  — ONLY after search_catalog found the table. Gets full column detail.",
      "  2. inspect_definition    — Read T-SQL source of views/procs. Detects DUPLICATE JOINS.",
      "  3. discover_relationships — FK graph traversal, join-path finder, implicit column matches.",
      "  4. profile_data          — Column stats, cardinality, nulls, top values. Essential before writing queries.",
      "  5. query_mssql           — Execute T-SQL. Always confirm columns with explore first.",
      "",
      "★ MANDATORY WORKFLOW — READ THIS:",
      "  Step 1: search_catalog(search='keyword') → find candidates. Read the metadata (row count, cols, joins).",
      "  Step 2: Pick the table with the BEST structural fit (most columns matching your need, right schema tier, connected).",
      "  Step 3: explore_mssql_schema(table='schema.Table') → confirm exact columns.",
      "  Step 4: query_mssql(sql='SELECT TOP 5 ...') → verify with data before scaling up.",
      "  NEVER skip Step 1. NEVER guess table names. NEVER dump entire schemas.",
      "",
      "DATA-FIRST + EFFICIENCY APPROACH:",
      "1. CATALOG FIRST: search_catalog is your primary discovery tool. Trust the structural signals (row count, centrality, schema tier).",
      "2. LINEAGE MAPS: For critical views like publish.Revenue and publish.Balances, DATABASE KNOWLEDGE contains full lineage maps.",
      "   Use these to understand what data feeds into a view and how to trace it to source facts/dimensions.",
      "3. USE JOINS MODE: search_catalog(joins='schema.Table') shows FK + implicit edges — no guessing needed.",
      "4. NEVER GUESS COLUMNS: explore_mssql_schema(table='schema.Table') before every query.",
      "5. SCHEMA-QUALIFY EVERYTHING: Always schema.table. Never bare names.",
      "6. RELATIONSHIP-FIRST: search_catalog(path=['A','B']) or discover_relationships(between=['A','B']) before multi-table queries.",
      "7. MAP BEFORE JOINING: Read view definitions with inspect_definition — views may already include the join you're adding.",
      "8. VERIFY THEN SCALE: SELECT TOP 5 first, full query only after shape is confirmed.",
      "9. VALID T-SQL ONLY: No pseudo-SQL. Every query_mssql call executes live.",
      "10. FIX ERRORS IMMEDIATELY: Read the error message. Don't retry the same broken query.",
      "",
      "ANTI-PATTERNS — NEVER DO THESE:",
      "  ✗ NEVER call explore_mssql_schema(schema='publish') to find a specific metric.",
      "    INSTEAD: search_catalog(search='revenue') → instant, precise, ranked results.",
      "  ✗ NEVER dump an entire schema to 'browse' — use search_catalog to search by keyword.",
      "  ✗ NEVER assume a table name from a large dump. Use search_catalog to find the exact match.",
      "  ✗ NEVER try a query on a table you haven't confirmed columns for.",
      "",
      "EFFICIENCY ANALYSIS MINDSET:",
      "When asked about pipeline performance, slow jobs, or unexpected runtime:",
      "  • inspect_definition(object='publish.ViewName') → read T-SQL, spot duplicate table references.",
      "  • inspect_definition(depends_on='publish.ViewName') → trace dependency chain.",
      "  • inspect_definition(search='TableName') → find every view/proc that touches a table.",
      "  • inspect_definition(slow_queries=true) → surface the most expensive live queries.",
      "  • inspect_definition(missing_indexes=true) → SQL Server's own index recommendations.",
      "  • inspect_definition(index_usage='schema.Table') → index usage vs waste.",
      "FINDING BAD JOINS: When a view joins the same table twice → DUPLICATE JOIN. inspect_definition flags these automatically.",
      "",
      "DATA DISPLAY RULE: For any report or data-display task, query_mssql for actual rows, then write_file a STATIC HTML — no server/API layer.",
    )
  }

  if (sections.length === 0) return ""
  return "\nCapabilities:\n  " + sections.join("\n  ")
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
