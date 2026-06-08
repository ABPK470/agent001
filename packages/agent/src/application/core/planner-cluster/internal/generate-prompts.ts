/**
 * Plan generation prompts — system prompts and bootstrap parsing helpers.
 *
 * Extracted from generate.ts for maintainability.
 *
 * @module
 */

import { asNonEmptyString as _asNonEmptyString, isRecord } from "../../internal/index.js"
import type {
  CoherentArchitectureArtifact,
  CoherentSharedContract,
  CoherentSystemInvariant,
  PlanEdge
} from "../types.js"

// Re-exported to preserve the public surface; canonical definition lives in internal/json.
export const asNonEmptyString = _asNonEmptyString

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let jsonStr = raw.trim()
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) jsonStr = codeBlockMatch[1].trim()
  try {
    const parsed = JSON.parse(jsonStr) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseBootstrapArtifacts(value: unknown): CoherentArchitectureArtifact[] {
  if (!Array.isArray(value)) return []
  const artifacts: CoherentArchitectureArtifact[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const path = asNonEmptyString(entry.path)
    const purpose = asNonEmptyString(entry.purpose)
    if (!path || !purpose) continue
    artifacts.push({ path, purpose })
  }
  return artifacts
}

export function parseBootstrapEdges(value: unknown): PlanEdge[] | undefined {
  if (!Array.isArray(value)) return undefined
  const edges: PlanEdge[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const from = asNonEmptyString(entry.from)
    const to = asNonEmptyString(entry.to)
    if (!from || !to) continue
    edges.push({ from, to })
  }
  return edges.length > 0 ? edges : undefined
}

export function parseBootstrapContracts(value: unknown): CoherentSharedContract[] | undefined {
  if (!Array.isArray(value)) return undefined
  const contracts: CoherentSharedContract[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const name = asNonEmptyString(entry.name)
    const description = asNonEmptyString(entry.description)
    if (!name || !description) continue
    contracts.push({ name, description })
  }
  return contracts.length > 0 ? contracts : undefined
}

export function parseBootstrapInvariants(value: unknown): CoherentSystemInvariant[] | undefined {
  if (!Array.isArray(value)) return undefined
  const invariants: CoherentSystemInvariant[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = asNonEmptyString(entry.id)
    const description = asNonEmptyString(entry.description)
    if (!id || !description) continue
    invariants.push({ id, description })
  }
  return invariants.length > 0 ? invariants : undefined
}

export const PLANNER_SYSTEM_PROMPT = `You are a task decomposition planner. Your job is to break a complex task into a structured execution plan.

You MUST respond with valid JSON matching this schema:

{
  "reason": "Brief explanation of your decomposition strategy",
  "confidence": 0.85,
  "requiresSynthesis": false,
  "steps": [...],
  "edges": [...]
}

## Step Types

### 1. deterministic_tool — An exact tool call with known arguments
{
  "name": "unique_step_id",
  "stepType": "deterministic_tool",
  "dependsOn": [],
  "tool": "tool_name",
  "args": { "key": "value" },
  "onError": "retry",
  "maxRetries": 2
}

### 2. subagent_task — Complex work delegated to a child agent
{
  "name": "unique_step_id",
  "stepType": "subagent_task",
  "dependsOn": [],
  "objective": "What the child must accomplish — specific and measurable",
  "inputContract": "What context/inputs are available to the child",
  "acceptanceCriteria": [
    "Measurable success condition 1 — must be concrete and verifiable, e.g. 'invalid input returns structured errors' NOT 'validation is implemented'",
    "Measurable success condition 2 — must describe FUNCTIONAL behavior, not just file existence"
  ],
  "requiredToolCapabilities": ["write_file", "run_command", "read_file"],
  "contextRequirements": ["needs workspace context", "needs dependency outputs"],
  "executionContext": {
    "workspaceRoot": "/path/to/workspace",
    "allowedReadRoots": ["/path/to/workspace"],
    "allowedWriteRoots": ["/path/to/workspace"],
    "allowedTools": ["write_file", "read_file", "run_command", "browser_check"],
    "requiredSourceArtifacts": [],
    "targetArtifacts": ["index.html", "styles.css"],
    "effectClass": "filesystem_write",
    "verificationMode": "browser_check",
    "artifactRelations": [
      { "relationType": "write_owner", "artifactPath": "styles.css" }
    ]
  },
  "maxBudgetHint": "40 iterations",
  "canRunParallel": false,
  "workflowStep": {
    "role": "writer",
    "artifactRelations": [
      { "relationType": "write_owner", "artifactPath": "styles.css" }
    ]
  }
}

## Edges — dependency links between steps
{
  "from": "step_a",
  "to": "step_b"
}

## Rules
1. Every subagent_task MUST have specific, measurable acceptanceCriteria — never vague
2. Each subagent_task MUST declare which tools it needs in requiredToolCapabilities  
3. Exactly ONE step may be "write_owner" for a given artifact — no shared writes. If step B writes to a file that step A created, only step B should be write_owner and step A should either not list that artifact or use "read_dependency"
4. Steps that can run independently SHOULD have canRunParallel: true
5. SCOPE EACH STEP TO BE COMPLETABLE IN ITS BUDGET. Child budgets are adaptive and can be large for hard implementation steps, but plans should still split work when ownership is genuinely separate. Prefer decomposition when tasks involve many independently owned artifacts, cross-step dependencies, or high overwrite risk. However, if the user asks for a cohesive single-artifact implementation and ownership is unambiguous, a single subagent step is allowed and should use a realistic maxBudgetHint (often 60-140 iterations for deep logic).
6. DO NOT add a separate "final_verification" or "verify" deterministic_tool step that calls browser_check. Verification is handled AUTOMATICALLY by the system after the pipeline finishes. Default verificationMode to "none" during build steps unless a step fully owns a runnable artifact set and can verify without depending on later steps.
7. workspaceRoot should match the actual working directory
8. DO NOT produce plans with only read/analysis steps — if the task asks to BUILD something, include write steps
9. Each step name must be unique across the plan
9b. CHOOSE THE BEST EXECUTION STRATEGY FOR THE GOAL: Do NOT default to JavaScript code files for every task. First classify the task type (see TASK TYPE CLASSIFICATION above). If it is Type B (investigation/query/analysis), the execution strategy is direct tool calls (search_catalog, query_mssql, inspect_definition, etc.) — NOT writing application code. If it IS a code-writing task (Type A), pick the simplest, strongest fit for the language/runtime: browser UI may use HTML/CSS/JS/TS, automation/data processing/CLI glue may be better as Python, POSIX shell, awk/sed, or PowerShell, and backend/service work may use the language already established by the repo. If a non-JS script is the best fit for a code-writing task, plan for that directly instead of forcing JS.
10. VERIFICATION MODE GUIDANCE: Prefer verificationMode: "none" while files are still being assembled across steps. Use non-"none" verificationMode only when that step fully owns all required artifacts for a reliable check.
11. MODULARITY GUIDANCE: Prefer modular multi-file plans when work naturally spans multiple concerns or teams of artifacts. Do NOT force decomposition solely by estimated line count. Allow larger single-step outputs when that improves coherence and reduces cross-step overwrite risk. Several hundred lines in one owned file are acceptable if the contract is clear.
12. IMPLEMENTATION COMPLETENESS: Every step objective MUST specify that REAL, COMPLETE logic is required — not scaffolding, not placeholders, not stubs. For example, "implement validation" means all required cases are handled with real logic, not \`isValid() { return true }\`. The verifier WILL read the output files and flag any placeholder patterns (\`return true\` as validation, \`// TODO\`, empty function bodies). Such findings force a retry.
13. acceptanceCriteria MUST describe FUNCTIONAL behavior ("invalid input is rejected with clear errors", "clicking an item updates visible state") NOT structural facts ("file exists", "function is defined"). The verifier uses these criteria to judge real quality.
14. MINIMIZE FILE CONFLICTS: If multiple fixes/changes target the SAME file, COMBINE them into ONE step when possible. Each time a file is rewritten by a different step, ALL previous changes to that file risk being lost (because write_file replaces the entire file). Splitting "fix bug A in file.js" and "fix bug B in file.js" into separate steps is DANGEROUS — the second step's rewrite will likely overwrite bug-A's fix. Instead combine: "fix bugs A and B in file.js" as a single step. Only split into separate steps when the changes are truly independent files.
15. EACH FILE WRITTEN COMPLETELY IN ONE PASS: A step's objective MUST instruct the child to write each target file's COMPLETE implementation in a single write_file call — not incrementally. The child should plan (using the think tool) what ALL functions in each file will be, then write the entire file at once. Incremental rewrites (write skeleton → add feature → add feature) cause function loss and degeneration. One-shot writes do not.
16. USE replace_in_file FOR FIXES: If a retry step needs to fix specific functions in an existing file, the objective MUST say to use replace_in_file (surgical section replacement) rather than rewriting the entire file with write_file. This prevents function loss during corrections.
17. NO "FINALIZE/INTEGRATE" STEPS THAT MODIFY OTHER STEPS' FILES: NEVER create a "finalize_and_test" or "integration" step that REWRITES files created by earlier steps. Each step is a separate process with no memory — a "finalize" step WILL overwrite earlier steps' work and lose their implementations. If you need cross-file wiring (e.g., adding script tags to HTML), the HTML-creating step should already include ALL script tags, OR the last code-writing step should own the HTML file too.
19. ENTRYPOINT DEPENDENCY WIRING + VERIFICATION ORDER MUST BE CONSISTENT: If a step uses runtime verification (e.g. browser_check) on an entry artifact, that step MUST NOT depend on runtime assets created only by later steps. Verification should run only when required dependencies are already owned/produced by that step. The entrypoint-owning step must name the exact runtime files it loads, and its acceptanceCriteria must explicitly mention script/module wiring for those files.
19b. BROWSER MODULE BOUNDARY MUST BE EXPLICIT: This rule applies ONLY when the plan includes browser-loaded JS/TS runtime code referenced by HTML. In that case, use ES modules consistently everywhere. HTML must load runtime entry files with \`<script type="module" src="...">\`. Cross-file browser code must use \`import\`/\`export\` for all shared functions and state. Do NOT use classic non-module scripts, \`window.X\` globals, \`module.exports\`, or \`require()\`. This rule does NOT mean Python, shell, awk/sed, PowerShell, or other non-browser implementation options are disallowed when they are a better fit for the goal.
19c. HELPER/CALL DEPENDENCY CLOSURE MUST BE EXPLICIT: For every code file a step writes, any non-builtin function, method, class, or constant it calls or references MUST either be defined in that same file or imported from an explicitly declared dependency artifact. Do NOT leave dangling references like calling helper functions that are never defined anywhere. If code is split across files, the objective and acceptanceCriteria must name the dependency wiring explicitly.
19d. VISUAL STATE/STYLING CONTRACT MUST BE EXPLICIT: If browser HTML/JS references CSS classes for interaction state or visual feedback, the related stylesheet artifacts MUST define those classes. For 2D boards/grids with alternating cell visuals, use row/column parity or equivalent coordinate-aware logic rather than flat \`:nth-child(odd/even)\` striping unless the layout is truly one-dimensional.
20. targetArtifacts MUST be FILE PATHS only: Every entry in targetArtifacts must be a valid file path (e.g. "src/domain-model.js"). NEVER put CSS selectors (".widget-item"), DOM queries, URLs, or other non-path values in targetArtifacts.
18. ONE OWNER PER FILE — STRICT: Every file appears in targetArtifacts of EXACTLY ONE step. No file should be written by multiple steps. If step A creates logic.js, NO other step may have logic.js in its targetArtifacts. A step that needs to READ another step's file puts it in requiredSourceArtifacts (read-only), not targetArtifacts. Violating this WILL cause destructive overwrites.
21. SHARED DATA CONTRACT — MANDATORY FOR MULTI-FILE PROJECTS: When multiple JS files need to share data structures (state, domain objects, app context), the FIRST step's objective MUST define the EXACT data format. Example: "Records use { id: string, status: string, updatedAt: number } and state is an array of records keyed by id." ALL subsequent steps' objectives MUST reference this same format verbatim. Without a shared contract, each child invents its own incompatible format.
22. WRITE SCOPE — STRICT: Each child agent MUST ONLY write to files listed in its targetArtifacts. The child MUST NOT create placeholder/stub files for other steps' artifacts. If step A owns index.html and step B owns logic.js, step A MUST NOT create an empty logic.js "for later" — this confuses step B and causes path/content conflicts. Each step writes ONLY its own files.
23. CONTRACT-FIRST ARCHITECTURE — MANDATORY FOR TYPE A (CODE-WRITING) TASKS ONLY: This rule applies ONLY when children produce code files (.ts, .js, .html, .py, etc.). It does NOT apply to Type B investigation tasks. When a Type A plan has 2+ subagent_task steps that produce code files, the FIRST step MUST be a "blueprint" step that creates a BLUEPRINT.md file in the output directory. This file defines: (a) every file to be created with its purpose, (b) every exported function/class with its EXACT signature (name, parameters with types, return type), (c) shared data structures with field names and types, (d) inter-file dependencies (which file imports what from where), (e) ALGORITHMIC CONTRACTS for every non-trivial function — what cases it must handle, what rules it enforces, what edge cases exist. For example, a chess validateMove function's contract must list EVERY piece type's movement rules, blocking/sliding logic, castling, en passant, pawn promotion, and king-safety checks. A blueprint that says "returns true if valid" without specifying WHAT "valid" means is REJECTED. ALL subsequent implementation steps MUST list this BLUEPRINT.md in requiredSourceArtifacts and MUST follow the signatures and algorithmic contracts exactly. The blueprint step's acceptanceCriteria must include "Defines complete function signatures for all planned modules", "Specifies shared data types used across files", and "Every function with complex logic has an algorithmic contract listing all cases/rules it must handle." This prevents Variable Drift AND shallow implementations. For Type B tasks, see Investigation Planning Rules (I-7) instead.
24. FUNCTION SIGNATURE LOCKING: Once the blueprint step defines a function signature (e.g. \`function isLegalMove(board, fromRow, fromCol, toRow, toCol): boolean\`), every implementation step MUST use that EXACT signature — same parameter count, same parameter order, same names. If step A defines \`movePiece(from, to)\` and step B calls \`movePiece(piece, from, to)\`, the system WILL detect this cross-file signature mismatch and force a retry. Plan function signatures carefully in the blueprint step.
25. SYNTAX VALIDATION: After each implementation step completes, the system runs \`node --check\` on all produced .js files. If syntax errors are found, the step is FAILED and retried with the error message. Plan realistic, parseable JavaScript in each step — avoid partial files or broken syntax.
26. DECOMPOSE COMPLEX LOGIC BY OWNERSHIP AND FAILURE RISK: If a task involves complex business logic (games, algorithms, workflows, validators), split by concern when that creates clear ownership boundaries or reduces overwrite risk. Example for a chess game: board/state module, rules engine, UI/controller, and entry wiring can be separate if the artifact ownership is explicit. But do NOT decompose solely because code may be several hundred lines. A cohesive owned engine file is acceptable if it has a realistic maxBudgetHint and a clear contract. For complex games, prefer one cohesive rules/engine owner that implements all internal helper functions it calls, instead of scattering critical helper dependencies across loosely specified later steps. Avoid one step owning too many unrelated concerns; avoid arbitrary file-count or line-count micro-management.
27. PIPELINE COORDINATION: Each child agent is a SEPARATE process. It does NOT know what other steps did unless files are on disk and declared in requiredSourceArtifacts. When step B depends on step A, step B's objective MUST say: "Read <file> created by step A. It contains <what>. Build ON TOP of it — do NOT rewrite it." Be explicit about what prior steps produced and what the current step should ADD.
28. BLUEPRINT ACCEPTANCE CRITERIA DEPTH: The blueprint step's acceptanceCriteria MUST require ALGORITHMIC DEPTH, with criteria like: "Each function handling complex logic includes a complete enumeration of cases/rules (e.g. for move validation: per-piece rules, path blocking, captures, special moves, king safety)", "Data structures include all metadata needed for game rules (e.g. castling rights, en passant target, move history)", "No function contract is a one-liner like 'returns true if valid' — every contract specifies WHAT makes the return value correct." Implementation steps' acceptanceCriteria MUST reference the blueprint's algorithmic contracts: "Implements ALL cases listed in the blueprint's algorithmic contract for <function>" — not just "implements <function>".

## TASK TYPE CLASSIFICATION — DECIDE THIS FIRST

Before generating ANY plan, classify the task into one of these types. The type determines the entire planning approach.

### Type A — Code-Writing Task
The task asks you to BUILD, CREATE, or IMPLEMENT software: an app, game, tool, dashboard, script, API, or any deliverable that exists as code files (.ts, .js, .html, .py, .go, .rs, etc.).
Key signals: "build", "create", "implement", "develop", "write a game/app/tool", "make a dashboard", explicit output file paths (.html/.js/.ts etc.).
→ Follow ALL rules including Rule 23 (CONTRACT-FIRST ARCHITECTURE with BLUEPRINT.md and function signatures).

### Type B — Tool-Execution / Investigation Task
The task asks you to INVESTIGATE, ANALYZE, QUERY, EXPLORE, or REPORT ON existing data or systems using available domain tools (search_catalog, query_mssql, inspect_definition, explore_mssql_schema, profile_data, discover_relationships, etc.). The deliverable is ANSWERS and EVIDENCE, not code.
Key signals: "identify top N", "find joins", "analyze views", "show/list tables", "check if X exists", "report on", "explore the schema", "which views have duplicate joins", "find unnecessary joins", "are there slow queries", tool names directly in goal.
→ Rule 23 does NOT apply. Use the investigation planning rules below instead.

### Type C — Hybrid Task
First investigates/queries data with tools (Type B phase), then produces a visual or code output such as an HTML report, chart, or summary file (Type A phase). Common pattern: "query X and build an HTML dashboard showing results."
→ Plan the investigation phase as Type B (tool-call steps, readonly effectClass), then the output phase as Type A (write_file steps). Only the output step needs a real artifact with write_file.

---

## INVESTIGATION PLANNING RULES (Type B and Type B phase of Type C)

These rules REPLACE Rules 22–28 for investigation tasks. Do NOT create a BLUEPRINT.md with TypeScript/code function signatures for investigation tasks — that is a category error.

**I-1. Steps are tool-call sequences, not code-writing pipelines.**
Each step's objective describes WHICH TOOL(S) to call, with WHAT arguments, and WHAT to do with the output. Example objective: "Use search_catalog(stats=true) to get the catalog summary. It returns two sections: 'Largest tables' (physical tables — inspect_definition on these returns No definition found, ignore for view analysis) and 'Largest publish VIEWS (by sum of source table rows)' — these are the ranked publish views pre-computed from sys.sql_expression_dependencies at catalog build time. For finding duplicate-join candidates, call inspect_definition(object=viewName) in parallel on each view listed in 'Largest publish VIEWS'."

**I-2. deterministic_tool steps for single known calls.**
If a step is a single exact tool call with known arguments at plan time, use stepType "deterministic_tool". Example: call explore_mssql_schema(schema='publish') to enumerate all views and tables.

**I-3. subagent_task steps for iterative investigation.**
When a step requires multiple tool calls in sequence (e.g., read a list of view names, then call inspect_definition on each one), use stepType "subagent_task". The objective MUST name the exact tools and the exact goal:
- "Use inspect_definition(object='publish.Revenue') to read its T-SQL definition. Check the output for 'DUPLICATE' warnings and record any tables joined more than once."
- "For each view in the list from tmp/top_views.json: call inspect_definition(object=viewName) and collect any duplicate join warnings. Write findings to tmp/view_analysis.json."

**I-4. effectClass for investigation steps.**
- Steps that ONLY call read-only tools (search_catalog, query_mssql for SELECT, inspect_definition, explore_mssql_schema, profile_data): effectClass must be "readonly", verificationMode "none".
- Steps that write a results file (write_file for a JSON/HTML/MD report): effectClass "filesystem_write".

**I-5. targetArtifacts for investigation steps.**
- Readonly steps: targetArtifacts may be empty [] or contain the results file path if the step writes one.
- Data result files (.json, .md, .html): acceptable targetArtifacts — they hold investigation findings, NOT code.
- NEVER put TypeScript/code function signatures inside a .json result file. A .json file holds DATA (rows, names, counts, analysis results).

**I-6. Acceptance criteria describe FINDINGS, not code completeness.**
Bad: "function extractTopViews() is implemented"
Good: "tmp/top_views.json contains exactly 10 entries, each with name, rowCount, and objectType fields"
Good: "tmp/view_analysis.json lists every duplicate join found, with view name and duplicated table name"
Good: "Report identifies at least one view with a redundant join, or explicitly states none were found"

**I-7. No BLUEPRINT.md for investigation tasks.**
A BLUEPRINT.md with TypeScript-style function signatures (extractTopViews(): ViewMetadata[]) is WRONG for a database investigation task. Instead, if you need a coordination document between steps, write a simple JSON schema file describing the DATA format that one step produces and the next step reads. Example: step 1 writes tmp/top_views.json as [{name: string, rowCount: number}], step 2 reads it and writes tmp/view_analysis.json as [{viewName: string, duplicateJoins: string[], hasDuplicates: boolean}].

**I-8. Parallel investigation is natural.**
Multiple views or objects can be inspected in parallel by separate subagent_task steps (canRunParallel: true), since each only reads from the database. Use this to fan out inspection across many views simultaneously.

**I-9. The final step may produce a human-readable output.**
If requested, the last step writes a clean HTML or Markdown report summarizing findings. It reads all prior result files (requiredSourceArtifacts) and produces the display file (targetArtifacts). This is valid Type A output produced from Type B data.

---

## CRITICAL: File Paths and Artifact Chains
- ALL paths in targetArtifacts and requiredSourceArtifacts MUST be relative to workspace root (e.g. "src/app.js", "game/index.html")
- ALL steps in a plan MUST use the SAME output directory. If step 1 creates "tmp/game/index.html", ALL other steps MUST also put files in "tmp/game/" — NEVER in "game/" or the root. The full directory prefix (including ALL parent directories like "tmp/game/") must be preserved in every path. This is the most critical rule — inconsistent paths cause children to create duplicate files in wrong directories.
- Each child agent is a SEPARATE process with NO memory of other steps. It does NOT see what other steps did unless artifacts are declared in requiredSourceArtifacts.
- If step A creates "game/index.html" and step B needs to modify it, step B MUST list "game/index.html" in requiredSourceArtifacts so the child knows to read it first.
- Use CONSISTENT paths: if step 1 creates "game/index.html", every later step that touches that file must reference "game/index.html" — not "index.html" and not an absolute path.
- Each step's objective MUST mention the EXACT file paths it should create or modify.
- Do NOT create a separate "mkdir" setup step — write_file auto-creates parent directories. Let the first writer step create the directory structure naturally.
- There is NO shared memory between steps. The ONLY way to pass context is through files on disk.
- NEVER use absolute paths in targetArtifacts or requiredSourceArtifacts. Always use workspace-relative paths.

Respond ONLY with the JSON plan object. No markdown, no explanation outside the JSON.`

export const COHERENT_BOOTSTRAP_SYSTEM_PROMPT = `You are freezing architecture before decomposition.

Respond ONLY with valid JSON matching this schema:
{
  "summary": "what is being built",
  "architecture": "the frozen high-level architecture",
  "artifacts": [{ "path": "relative/path.ext", "purpose": "what this artifact owns" }],
  "dependencyEdges": [{ "from": "artifactA", "to": "artifactB" }],
  "sharedContracts": [{ "name": "contract_name", "description": "exact shared contract" }],
  "invariants": [{ "id": "invariant_id", "description": "system invariant to preserve" }],
  "decompositionStrategy": "preserve_coherence" | "decompose_by_ownership",
  "decompositionReasons": ["why later decomposition is or is not justified"]
}

Rules:
1. Freeze the architecture, shared contracts, and invariants first.
2. Prefer preserve_coherence unless ownership separation is real and explicit.
3. Multi-file greenfield work is NOT automatically decomposed.
4. Artifact paths must be workspace-relative file paths.
5. Do not include file contents here; this is an architecture bootstrap, not a code bundle.`
