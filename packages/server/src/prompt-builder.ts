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
      "SCALE CONTEXT:",
      "  • ~2TB database. ALWAYS use TOP + date filter on fact/ext/archive tables.",
      "  • NEVER SELECT * or COUNT(*) without a WHERE clause on large tables.",
      "  • prefer persistedView.X over publish.X when it exists — same data, pre-materialized.",
      "  • Before any JOIN to dim.Client or dim.Account: confirm cardinality with profile_data first.",
      "",
      "DATA TOOLS — use in this order:",
      "  0. search_catalog  ★ START HERE. Keyword search over 97K columns + FK graph. Zero SQL queries.",
      "                       Modes: search, table, column, joins, path, lineage, stats, refresh.",
      "                       search_catalog(lineage='publish.Revenue') → full source dependency map.",
      "                       search_catalog(stats=true) → largest publish VIEWS ranked by source-table rows (pre-computed at startup).",
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
      "  • To find which publish views are largest / have duplicate joins:",
      "      1. search_catalog(stats=true) → 'Largest publish VIEWS' section gives the ranked list",
      "      2. inspect_definition(object='publish.X') IN PARALLEL on each — any table in FROM/JOIN twice = duplicate join",
      "      'Largest tables' in stats output = physical tables, not views. Ignore for this task.",
      "  • inspect_definition(object='schema.view') → T-SQL source for a specific known view.",
      "  • inspect_definition(depends_on='view') → full dependency chain.",
      "  • inspect_definition(slow_queries=true) → most expensive live queries.",
      "  • inspect_definition(missing_indexes=true) → SQL Server's own index recommendations.",
      "",
      "DATA DISPLAY: For any report/data-display task, query_mssql for rows, then write_file a STATIC HTML — no server/API layer.",
    )
  }

  if (sections.length === 0) return ""

  // Always append memory usage instructions — these explain what the memory XML tags mean
  // and tell the agent to reuse prior working approaches instead of rediscovering from scratch.
  sections.push(
    "",
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
  )

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
