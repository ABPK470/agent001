/**
 * Prompt builder — constructs system-prompt sections for agent runs.
 *
 * Extracted from orchestrator.ts so the prompt logic is testable
 * and reusable independently of the run lifecycle.
 */

import { getMssqlConfig, type Tool } from "@agent001/agent"
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
    t.name === "discover_relationships" || t.name === "profile_data",
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

    sections.push(
      "",
      "DATA-FIRST MINDSET (you are a database relationship and data expert):",
      "You have deep tools for understanding database structure and data. Use them proactively:",
      "- discover_relationships: Map FK graphs, find join paths between tables, spot implicit relationships via shared column names.",
      "- profile_data: Understand what's actually IN the data — cardinality, nulls, distributions, frequent values.",
      "- explore_mssql_schema: Discover exact column names, types, and primary/foreign keys.",
      "- query_mssql: Execute validated T-SQL queries.",
      "",
      "RELATIONSHIP-FIRST APPROACH:",
      "1. MAP RELATIONSHIPS FIRST: Before writing any multi-table query, call discover_relationships to understand how tables connect. Use between=['A','B'] to find join paths.",
      "2. EXPLORE COLUMNS: Call explore_mssql_schema(table='schema.Table') for every table you plan to query. NEVER guess column names.",
      "3. PROFILE WHEN UNCERTAIN: If you're unsure about data shape, cardinality, or common values, call profile_data before writing the analytical query.",
      "4. SCHEMA-QUALIFY EVERYTHING: Always use schema.table (e.g. agent.vPipelineRun, core.Pipeline). Never bare table names.",
      "5. SUGGEST CONNECTIONS: When the user asks about a table, proactively discover and mention related tables — both direct FK relationships and implicit column-name matches.",
      "6. VERIFY THEN SCALE: First run SELECT TOP 5 to confirm shape. Only then write the full query.",
      "7. USE KNOWLEDGE FILE: The DATABASE KNOWLEDGE section tells you which schemas exist and how they relate. Start there, then use tools to drill deeper.",
      "8. VALID T-SQL ONLY: Every query must be syntactically valid T-SQL. No pseudo-code.",
      "9. HANDLE ERRORS: Read error messages carefully. Fix the query — don't retry the same broken one.",
      "10. THINK IN GRAPHS: The database is a connected graph. Every ID column is a potential edge. Use discover_relationships(column='someId') to find where IDs connect across schemas.",
      "",
      "DATA DISPLAY RULE: For any report, table, chart, or data-display task, query_mssql for actual rows, then write_file a STATIC HTML with data embedded inline — no server/API layer.",
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
