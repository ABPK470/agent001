import type { ToolCallRecord } from "../recovery.js"
import type { Message, Tool, ToolResultEnvelope } from "../types.js"
import { isValidArtifactPath } from "./generate.js"
import type {
    ArtifactRelation,
    CoherentSharedContract,
    CoherentSolutionArtifact,
    CoherentSolutionBundle,
    CoherentSystemInvariant,
    PipelineResult,
    PipelineStepResult,
    Plan,
    PlanEdge,
    VerifierDecision,
    VerifierIssue,
} from "./types.js"

const COHERENT_GENERATION_PROMPT = `You are generating a coherent multi-file implementation bundle.

Goal:
- produce the full architecture in one pass
- keep names, contracts, and file boundaries internally consistent
- return complete file contents for every artifact in the bundle

Rules:
1. Respond ONLY with a JSON object.
2. Prefer a bounded, cohesive solution with a small number of files.
3. Every artifact entry must include path, purpose, and complete file content.
4. File contents must be final code/content, not placeholders or TODOs.
5. Keep shared naming, imports, and state contracts consistent across all artifacts.
6. Do not include markdown fences around file contents.
7. OUTPUT DIRECTORY ISOLATION: Generate all new artifacts inside a single fresh project subdirectory (e.g. \`project/\`, \`app/\`, or a semantically meaningful name like \`client-report/\`). Do NOT place files inside existing source directories such as \`packages/\`, \`src/\`, \`lib/\`, or \`dist/\` unless the goal explicitly targets modifying files that already exist there. A new standalone project must live in its own directory, not mixed into the host repository.

Return JSON of this shape:
{
  "summary": "what the solution is",
  "architecture": "how the files fit together",
  "artifacts": [
    {
      "path": "relative/path.ext",
      "purpose": "what this file owns",
      "content": "full file content"
    }
  ],
  "dependencyEdges": [{ "from": "a", "to": "b" }],
  "sharedContracts": [{ "name": "contract", "description": "exact shared contract" }],
  "invariants": [{ "id": "invariant_id", "description": "system-level invariant" }]
}`

export interface CoherentBundleParseResult {
  readonly bundle: CoherentSolutionBundle | null
  readonly diagnostics: readonly string[]
}

export interface CoherentMaterializationResult {
  readonly writtenArtifacts: readonly string[]
  readonly readBackArtifacts: readonly string[]
  readonly diagnostics: readonly string[]
}

const COHERENT_STEP_NAME = "coherent_bundle"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
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

function parseArtifacts(value: unknown, diagnostics: string[]): CoherentSolutionArtifact[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push("Bundle must contain a non-empty artifacts array.")
    return []
  }

  const seenPaths = new Set<string>()
  const artifacts: CoherentSolutionArtifact[] = []

  for (const entry of value) {
    if (!isRecord(entry)) {
      diagnostics.push("Each artifact must be an object with path, purpose, and content.")
      continue
    }
    const path = asNonEmptyString(entry.path)
    const purpose = asNonEmptyString(entry.purpose)
    const content = asNonEmptyString(entry.content)
    if (!path || !purpose || !content) {
      diagnostics.push("Each artifact requires non-empty path, purpose, and content fields.")
      continue
    }
    if (!isValidArtifactPath(path)) {
      diagnostics.push(`Artifact path \"${path}\" is invalid.`)
      continue
    }
    if (seenPaths.has(path)) {
      diagnostics.push(`Artifact path \"${path}\" is duplicated in the coherent bundle.`)
      continue
    }
    seenPaths.add(path)

    // Reject code artifacts that contain TODO placeholders — the coherent bundle
    // must be fully implemented. Stub code causes an unrecoverable repair loop:
    // the write guard blocks the next write for missing functions, while the
    // repair instructions forbid restructuring, trapping the agent in a read spin.
    const isCodeArtifact = /\.(js|ts|jsx|tsx|mjs|cjs|py|java|go|rs|rb|php|cs|cpp|c|h|sh|bash|zsh)$/i.test(path)
    if (isCodeArtifact) {
      const todoLine = content.split("\n").find(l =>
        /\/\/\s*TODO[:\s]|\/\*\s*TODO\b|#\s*TODO[:\s]/.test(l),
      )
      if (todoLine) {
        diagnostics.push(
          `Artifact "${path}" contains TODO placeholders — all coherent bundle artifacts must be fully implemented, not stubs. ` +
          `Found: ${todoLine.trim().slice(0, 120)}`,
        )
        continue
      }
    }

    artifacts.push({ path, purpose, content })
  }

  return artifacts
}

function parseEdges(value: unknown): PlanEdge[] | undefined {
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

function parseSharedContracts(value: unknown): CoherentSharedContract[] | undefined {
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

function parseInvariants(value: unknown): CoherentSystemInvariant[] | undefined {
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

function normalizeToolResult(result: string | ToolResultEnvelope): { ok: boolean; summary: string } {
  if (typeof result === "string") {
    return {
      ok: !/^Error:/i.test(result),
      summary: result,
    }
  }
  return {
    ok: result.ok !== false,
    summary: result.summary,
  }
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

function isArtifactScopedToolCall(record: ToolCallRecord, artifactPaths: ReadonlySet<string>): boolean {
  const pathValue = typeof record.args.path === "string" ? normalizeArtifactPath(record.args.path) : null
  if (pathValue && artifactPaths.has(pathValue)) return true

  const commandValue = typeof record.args.command === "string" ? record.args.command : null
  if (!commandValue) return false
  for (const artifactPath of artifactPaths) {
    if (commandValue.includes(artifactPath)) return true
  }
  return false
}

function buildArtifactRelations(artifacts: readonly CoherentSolutionArtifact[]): ArtifactRelation[] {
  return artifacts.map((artifact) => ({
    relationType: "write_owner",
    artifactPath: artifact.path,
  }))
}

export function buildCoherentGenerationMessages(
  goal: string,
  workspaceRoot: string,
  history: readonly Message[],
): Message[] {
  // Keep anchor/persona system messages but strip the workspace directory listing.
  // The directory listing shows existing source directories (e.g. packages/ui,
  // packages/server) which cause the LLM to write generated code into the host
  // repo's own source tree instead of a fresh project subdirectory.
  const baseSystemMessages = history.filter(
    (message) =>
      message.role === "system" &&
      !message.content?.trimStart().startsWith("Workspace:"),
  )
  return [
    ...baseSystemMessages,
    { role: "system", content: COHERENT_GENERATION_PROMPT, section: "system_runtime" },
    {
      role: "user",
      content:
        `Workspace root: ${workspaceRoot}\n` +
        `Goal: ${goal}\n\n` +
        "Produce a coherent multi-file solution bundle that can be materialized directly.",
      section: "user",
    },
  ]
}

export function parseCoherentSolutionBundle(raw: string): CoherentBundleParseResult {
  const diagnostics: string[] = []
  const parsed = parseJsonObject(raw)
  if (!parsed) {
    return {
      bundle: null,
      diagnostics: ["Coherent generation response is not valid JSON."],
    }
  }

  const summary = asNonEmptyString(parsed.summary)
  const architecture = asNonEmptyString(parsed.architecture)
  if (!summary) diagnostics.push("Bundle must include a non-empty summary.")
  if (!architecture) diagnostics.push("Bundle must include a non-empty architecture description.")

  const artifacts = parseArtifacts(parsed.artifacts, diagnostics)
  if (diagnostics.length > 0 || !summary || !architecture) {
    return { bundle: null, diagnostics }
  }

  return {
    bundle: {
      summary,
      architecture,
      artifacts,
      dependencyEdges: parseEdges(parsed.dependencyEdges),
      sharedContracts: parseSharedContracts(parsed.sharedContracts),
      invariants: parseInvariants(parsed.invariants),
    },
    diagnostics,
  }
}

export function buildCoherentVerificationPlan(
  bundle: CoherentSolutionBundle,
  workspaceRoot: string,
): Plan {
  const artifactRelations = buildArtifactRelations(bundle.artifacts)
  const acceptanceCriteria = uniqueStrings([
    "Every declared artifact exists at the exact planned path with non-placeholder content.",
    ...bundle.sharedContracts?.map((contract) => `Preserve shared contract ${contract.name}: ${contract.description}`) ?? [],
    ...bundle.invariants?.map((invariant) => `Preserve invariant ${invariant.id}: ${invariant.description}`) ?? [],
  ])

  return {
    reason: `Coherent bundle verification for ${bundle.summary}`,
    confidence: 0.88,
    requiresSynthesis: false,
    edges: [],
    steps: [
      {
        name: COHERENT_STEP_NAME,
        stepType: "subagent_task",
        objective: `Materialize and preserve the coherent bundle architecture: ${bundle.architecture}`,
        inputContract: bundle.summary,
        acceptanceCriteria,
        requiredToolCapabilities: ["read_file", "browser_check", "run_command", "write_file", "replace_in_file"],
        contextRequirements: [
          `Architecture: ${bundle.architecture}`,
          `Artifacts: ${bundle.artifacts.map((artifact) => artifact.path).join(", ")}`,
        ],
        executionContext: {
          workspaceRoot,
          allowedReadRoots: [workspaceRoot],
          allowedWriteRoots: [workspaceRoot],
          allowedTools: ["read_file", "browser_check", "run_command", "write_file", "replace_in_file"],
          requiredSourceArtifacts: [],
          targetArtifacts: bundle.artifacts.map((artifact) => artifact.path),
          effectClass: "filesystem_write",
          verificationMode: "deterministic_followup",
          artifactRelations,
          role: "writer",
          forbiddenArtifacts: [],
          requiredChecks: ["read_file"],
        },
        maxBudgetHint: "coherent_bundle_repair",
        canRunParallel: false,
        workflowStep: {
          role: "writer",
          artifactRelations,
        },
      },
    ],
  }
}

export function buildCoherentVerificationPipelineResult(
  bundle: CoherentSolutionBundle,
  toolCalls: readonly ToolCallRecord[],
): PipelineResult {
  const artifactPathSet = new Set(bundle.artifacts.map((artifact) => normalizeArtifactPath(artifact.path)))
  const relevantToolCalls = toolCalls.filter((record) => isArtifactScopedToolCall(record, artifactPathSet))
  const writeSummaries = relevantToolCalls
    .filter((record) => record.name === "write_file" || record.name === "replace_in_file" || record.name === "append_file")
    .map((record) => {
      const path = typeof record.args.path === "string" ? String(record.args.path) : "unknown"
      return `Successfully wrote to \`${path}\``
    })
  const readSummaries = relevantToolCalls
    .filter((record) => record.name === "read_file")
    .map((record) => {
      const path = typeof record.args.path === "string" ? String(record.args.path) : "unknown"
      return `Reviewed artifact \`${path}\``
    })
  const verificationAttempts = relevantToolCalls
    .filter((record) => record.name === "read_file" || record.name === "browser_check" || record.name === "run_command")
    .map((record) => ({
      toolName: record.name,
      target: typeof record.args.path === "string" ? String(record.args.path) : undefined,
      success: !record.isError,
      summary: record.result,
    }))

  const stepResult: PipelineStepResult = {
    name: COHERENT_STEP_NAME,
    status: "completed",
    executionState: "executed",
    acceptanceState: "pending_verification",
    output: [
      "Coherent bundle materialized for verification.",
      ...writeSummaries,
      ...readSummaries,
      `Architecture: ${bundle.architecture}`,
      `Artifacts: ${bundle.artifacts.map((artifact) => `\`${artifact.path}\``).join(", ")}`,
    ].join("\n"),
    durationMs: 0,
    toolCalls: relevantToolCalls,
    producedArtifacts: bundle.artifacts.map((artifact) => artifact.path),
    modifiedArtifacts: bundle.artifacts.map((artifact) => artifact.path),
    verificationAttempts,
    childResult: {
      status: relevantToolCalls.some((record) => record.isError) ? "failed" : "success",
      summary: bundle.summary,
      producedArtifacts: bundle.artifacts.map((artifact) => artifact.path),
      modifiedArtifacts: bundle.artifacts.map((artifact) => artifact.path),
      verificationAttempts,
      unresolvedBlockers: [],
    },
  }

  return {
    status: "completed",
    stepResults: new Map([[COHERENT_STEP_NAME, stepResult]]),
    completedSteps: 1,
    totalSteps: 1,
  }
}

function collectDecisionIssues(decision: VerifierDecision): string[] {
  return uniqueStrings([
    ...decision.steps
      .filter((step) => step.outcome !== "pass")
      .flatMap((step) => step.issues),
    ...decision.unresolvedItems,
    ...decision.systemChecks?.map((check) => check.summary) ?? [],
  ])
}

function collectAffectedArtifacts(decision: VerifierDecision): string[] {
  return uniqueStrings(
    decision.steps.flatMap((step) =>
      step.issueDetails?.flatMap((issue) => issue.affectedArtifacts) ?? [],
    ),
  )
}

function formatRepairFocus(issue: VerifierIssue): string {
  const affected = issue.affectedArtifacts.length > 0 ? ` [${issue.affectedArtifacts.join(", ")}]` : ""
  return `- ${issue.summary}${affected}`
}

export function buildCoherentRepairInstructions(
  bundle: CoherentSolutionBundle,
  decision: VerifierDecision,
  repairAttempt: number,
): string {
  const issues = collectDecisionIssues(decision)
  const focusedIssues = uniqueStrings(
    decision.steps.flatMap((step) =>
      step.issueDetails?.map((issue) => formatRepairFocus(issue)) ?? [],
    ),
  )
  const affectedArtifacts = collectAffectedArtifacts(decision)
  const sharedContracts = bundle.sharedContracts?.map((contract) => `${contract.name}: ${contract.description}`) ?? []
  const invariants = bundle.invariants?.map((invariant) => `${invariant.id}: ${invariant.description}`) ?? []

  // Detect browser module architecture errors — when present, targeted repair is
  // impossible without restructuring (the module import error is constitutional,
  // not a logic bug). Relax the "do not redesign" constraint for those cases.
  const allIssueText = issues.concat(focusedIssues).join(" ").toLowerCase()
  const hasBrowserModuleError =
    /module mismatch|cannot use import statement|import.*outside.*module|type.*module/.test(allIssueText)

  return [
    `COHERENT REPAIR REQUIRED — attempt ${repairAttempt}.`,
    `Preserve the existing architecture: ${bundle.architecture}`,
    hasBrowserModuleError
      ? [
          `ARCHITECTURE CORRECTION REQUIRED: a browser ES module error was detected.`,
          `You MUST fix the module loading strategy — choose one of:`,
          `  (a) Change all HTML <script> tags for the affected files to use type="module" (e.g. <script type="module" src="chess.js">), ensuring the HTML loads every file that uses import/export as a module.`,
          `  (b) Remove all import/export statements and inline helper code directly into the entry file — this produces a single self-contained script that works in any browser context.`,
          `Both approaches are acceptable. Whichever you choose, make ALL affected files consistent (HTML + every JS file).`,
        ].join("\n")
      : `Do NOT redesign or decompose the solution. Perform targeted repairs inside the existing coherent bundle first.`,
    `Artifacts in scope: ${bundle.artifacts.map((artifact) => artifact.path).join(", ")}`,
    affectedArtifacts.length > 0 ? `Focus first on: ${affectedArtifacts.join(", ")}` : "Focus first on the artifacts implicated by the verifier findings.",
    sharedContracts.length > 0 ? `Shared contracts to preserve:\n${sharedContracts.map((item) => `- ${item}`).join("\n")}` : "",
    invariants.length > 0 ? `System invariants to preserve:\n${invariants.map((item) => `- ${item}`).join("\n")}` : "",
    focusedIssues.length > 0
      ? `Verifier findings:\n${focusedIssues.join("\n")}`
      : `Verifier findings:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    `Required workflow:`,
    `1. Read the affected files before modifying them.`,
    `2. Make the smallest repair that fixes the verified issue.`,
    `3. Preserve file interfaces, imports, and contracts unless the verifier evidence proves they are wrong.`,
    `4. Re-read the repaired files and verify behavior before finishing.`,
    `HARD CONSTRAINTS — violation causes immediate failure:`,
    `- Do NOT start server processes (node server.js, npm start, etc.) to verify code — the backend will be started by the user separately.`,
    `- Do NOT run package installation commands (npm install, yarn add, pnpm add, bun add, etc.) — dependencies must be declared in package.json files, not installed live.`,
    `- If browser_check shows ERR_CONNECTION_REFUSED to a local API, that means the backend is not running — this is expected and NOT a code bug to fix.`,
    `Do not ask the user whether to continue. Repair now.`,
  ].filter(Boolean).join("\n\n")
}

export function buildCoherentPlannerEscalationGoal(
  originalGoal: string,
  bundle: CoherentSolutionBundle,
  decision: VerifierDecision,
): string {
  const issues = collectDecisionIssues(decision)
  return [
    `Repair the existing coherent bundle using structured planner coordination.`,
    `Original goal: ${originalGoal}`,
    `This is existing-code repair, not greenfield generation.`,
    `Preserve this architecture unless evidence proves a specific interface is broken: ${bundle.architecture}`,
    `Current artifacts: ${bundle.artifacts.map((artifact) => artifact.path).join(", ")}`,
    `Verified issues to fix:`,
    ...issues.map((issue) => `- ${issue}`),
    `Produce a repair plan that applies the smallest coordinated fixes necessary across the existing artifacts.`,
  ].join("\n")
}

export function summarizeCoherentVerifierDecision(decision: VerifierDecision): {
  overall: VerifierDecision["overall"]
  confidence: number
  issueCount: number
  systemCheckCount: number
  issues: readonly string[]
  affectedArtifacts: readonly string[]
} {
  const issues = collectDecisionIssues(decision)
  const affectedArtifacts = collectAffectedArtifacts(decision)
  return {
    overall: decision.overall,
    confidence: decision.confidence,
    issueCount: issues.length,
    systemCheckCount: decision.systemChecks?.length ?? 0,
    issues,
    affectedArtifacts,
  }
}

export async function materializeCoherentSolutionBundle(
  bundle: CoherentSolutionBundle,
  tools: {
    readonly writeFileTool?: Tool
    readonly readFileTool?: Tool
  },
): Promise<CoherentMaterializationResult> {
  const diagnostics: string[] = []
  const writtenArtifacts: string[] = []
  const readBackArtifacts: string[] = []

  if (!tools.writeFileTool) {
    return {
      writtenArtifacts,
      readBackArtifacts,
      diagnostics: ["write_file tool is unavailable for coherent bundle materialization."],
    }
  }

  for (const artifact of bundle.artifacts) {
    const writeResult = normalizeToolResult(await tools.writeFileTool.execute({
      path: artifact.path,
      content: artifact.content,
    }))
    if (!writeResult.ok) {
      diagnostics.push(`write_file failed for ${artifact.path}: ${writeResult.summary}`)
      continue
    }
    writtenArtifacts.push(artifact.path)

    if (tools.readFileTool) {
      const readResult = normalizeToolResult(await tools.readFileTool.execute({ path: artifact.path }))
      if (!readResult.ok) {
        diagnostics.push(`read_file failed for ${artifact.path}: ${readResult.summary}`)
        continue
      }
      readBackArtifacts.push(artifact.path)
    }
  }

  return {
    writtenArtifacts,
    readBackArtifacts,
    diagnostics,
  }
}