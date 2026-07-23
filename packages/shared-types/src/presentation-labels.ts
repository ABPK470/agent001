/** Progressive tool labels for AgentChat timeline rows. */
export const TOOL_LABELS: Record<string, string> = {
  search_catalog: "Searching catalog",
  inspect_definition: "Inspecting definition",
  explore_mssql_schema: "Exploring schema",
  query_mssql: "Running SQL query",
  profile_data: "Profiling data",
  discover_relationships: "Discovering relationships",
  read_file: "Reading file",
  write_file: "Writing file",
  append_file: "Appending file",
  replace_in_file: "Editing file",
  list_directory: "Listing directory",
  search_files: "Searching files",
  run_command: "Running command",
  fetch_url: "Fetching URL",
  think: "Thinking",
  ask_user: "Asking user",
  sync_preview: "Previewing sync",
  sync_execute: "Executing sync",
  list_sync_definitions: "Listing sync definitions",
  resolve_sync_scope: "Resolving sync scope",
  sync_diff_scan: "Scanning diffs",
  list_environments: "Listing environments",
  compare_catalogs: "Comparing catalogs",
}

/** Short verb labels for TermChat narrative. */
export const TERM_TOOL_LABELS: Record<string, string> = {
  read_file: "read",
  write_file: "write",
  replace_in_file: "edit",
  list_dir: "list",
  grep_search: "search",
  file_search: "find",
  search_files: "search",
  search_catalog: "search catalog",
  explore_mssql_schema: "inspect schema",
  query_mssql: "query database",
  run_command: "run",
  fetch_url: "fetch",
  delegate: "delegate",
  ask_user: "ask user",
  sync_preview: "preview sync",
  sync_execute: "run sync",
  sync_diff_scan: "scan sync diffs",
  compare_catalogs: "compare catalogs",
  list_sync_definitions: "list sync definitions",
  resolve_sync_scope: "resolve sync scope",
  list_environments: "list environments",
  search_sync_entities: "search sync entities",
}

export const TOOL_PAST_TENSE: Record<string, string> = {
  read: "read files",
  write: "wrote files",
  edit: "edited files",
  list: "listed files",
  search: "searched files",
  find: "found files",
  "search catalog": "searched catalog",
  "inspect schema": "inspected schema",
  "query database": "queried database",
  run: "ran command",
  fetch: "fetched URL",
  delegate: "delegated work",
  "ask user": "asked user",
}

export function termToolDisplayLabel(tool: string): string {
  return TERM_TOOL_LABELS[tool] ?? tool.replace(/_/g, " ")
}
