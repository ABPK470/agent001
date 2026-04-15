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

  const hasMssql = tools.some((t) => t.name === "query_mssql" || t.name === "explore_mssql_schema")
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
      "SQL DISCIPLINE (follow strictly for EVERY database interaction):",
      "1. EXPLORE FIRST: Before writing ANY query, call explore_mssql_schema to discover exact column names. This is NOT optional — do it for every table you plan to query.",
      "2. NEVER GUESS COLUMNS: Column names are often non-obvious. If you haven't explored a table, you don't know its columns. Use explore_mssql_schema(table='schema.TableName') every time.",
      "3. SCHEMA-QUALIFY EVERYTHING: Always use schema.table (e.g. agent.vPipelineRun, core.Pipeline). Never use bare table names.",
      "4. FIND RELATED DATA: If a table has an ID column but not the label/name you need, use explore_mssql_schema(search='keyword') to find a related table that has both the ID and the descriptive columns, then JOIN them.",
      "5. VERIFY THEN SCALE: First run a small query (SELECT TOP 5 ...) to confirm columns and data shape. Only then write the full analytical query.",
      "6. USE KNOWLEDGE FILE: The DATABASE KNOWLEDGE section tells you which schemas exist and how they relate. Use it to pick the right schema, then explore to find exact tables and columns.",
      "7. VALID T-SQL ONLY: Every query_mssql call must be syntactically valid T-SQL. No pseudo-code, no placeholder syntax, no made-up functions.",
      "8. HANDLE ERRORS: If a query fails, read the error message carefully. Fix the query based on the error — don't retry the same broken query.",
      "",
      "Use explore_mssql_schema to discover exact column names and types when composing queries.",
      "Use query_mssql to run T-SQL queries. When asked about data, revenue, customers, sales, or any analytical question, query the database.",
      "DATA DISPLAY RULE: For any report, table, chart, or data-display task, ALWAYS use query_mssql to get the actual rows NOW, then use write_file to create a STATIC HTML file with the real data embedded directly as an inline <table> or JSON constant — DO NOT generate a Node.js server, Express app, or API layer. The backend is not running during file generation; static HTML with embedded data is the correct and complete deliverable.",
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
