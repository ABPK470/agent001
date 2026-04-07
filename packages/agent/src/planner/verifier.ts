/**
 * Verifier — post-pipeline verification of execution results.
 *
 * Two-phase verification (agenc-core pattern):
 *   1. Deterministic probes — check file existence, run build/test commands
 *   2. LLM-based assessment — structured confidence check per step
 *
 * @module
 */

import type { LLMClient, Message, Tool } from "../types.js"
import type {
    PipelineResult,
    Plan,
    SubagentTaskStep,
    VerifierDecision,
    VerifierOutcome,
    VerifierStepAssessment,
} from "./types.js"

// ============================================================================
// Constants (ported from agenc-core chat-executor-verifier.ts)
// ============================================================================

/** Min verifier confidence for accepting subagent outputs. */
const DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE = 0.65
/** Max chars retained from one subagent output in verifier prompts. */
// const MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS = 3_000

/** Evidence density indicators — output that contains these is more trustworthy. */
const EVIDENCE_DENSITY_RE = /(line|file|log|trace|stderr|stdout|stack|error|\d)/i
/** Hallucination risk: phrases suggesting the model is referencing artifacts without evidence. */
const HALLUCINATION_CLAIM_RE = /(according to|as seen in|from the logs|based on)/i
/** Source-like file paths that indicate real implementation work. */
const SOURCE_LIKE_PATH_RE =
  /(?:^|\/)(?:src|lib|app|server|client|cmd|pkg|include|internal|tests?|spec)(?:\/|$)|\.(?:c|cc|cpp|cxx|h|hpp|rs|go|py|rb|php|java|kt|swift|cs|js|jsx|ts|tsx|json|toml|yaml|yml|xml|sh|zsh|bash)$/i
/** Shell mutation pattern — commands that indicate workspace modifications. */
// const SHELL_MUTATION_RE =
//   /(?:^|[;&|]\s*|\n)\s*(?:cp|mv|rm|mkdir|touch|tee|sed|perl|python|node|ruby|go|cargo|npm|pnpm|yarn|make|cmake)\b|>>?/i
/** Direct mutation tool names. */
// const DIRECT_MUTATION_TOOLS = new Set(["write_file", "delete"])

// ============================================================================
// Deterministic probes
// ============================================================================

/**
 * Extract actual file paths from child agent output text.
 * Children typically report "Successfully created `path/file.js`" or mention paths they wrote.
 */
function extractActualPaths(output: string): string[] {
  const paths: string[] = []
  // Match backtick-quoted paths: `path/file.ext`
  for (const m of output.matchAll(/`([^`\s]+\.[a-zA-Z0-9]+)`/g)) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  // Match "created/wrote/modified <path>" patterns
  for (const m of output.matchAll(/(?:creat|writ|wrote|modif|generat)\w*\s+(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  // Deduplicate
  return [...new Set(paths)]
}

/**
 * Try to read a file, attempting the exact path first, then matching against
 * paths the child actually wrote, then searching with `find` as last resort.
 * Returns { found: true, resolvedPath } on success, { found: false } on failure.
 */
async function probeArtifact(
  readFile: Tool,
  plannedPath: string,
  actualPaths: string[],
  workspaceRoot?: string,
  runCommand?: Tool,
  allowedWriteRoots?: readonly string[],
): Promise<{ found: boolean; resolvedPath: string }> {
  // Build candidate paths: planned path both bare and prefixed with workspaceRoot
  const candidates: string[] = [plannedPath]
  if (workspaceRoot && !plannedPath.startsWith(workspaceRoot)) {
    const rooted = workspaceRoot.endsWith("/")
      ? `${workspaceRoot}${plannedPath}`
      : `${workspaceRoot}/${plannedPath}`
    candidates.unshift(rooted) // try workspace-rooted path first
  }

  // Also try write-root-scoped paths: if allowedWriteRoots is a subdir of
  // workspaceRoot (e.g. "/project/tmp"), try "tmp/index.html" for bare "index.html"
  if (allowedWriteRoots && workspaceRoot && !plannedPath.includes("/")) {
    const wsNorm = workspaceRoot.replace(/\/$/, "")
    for (const wr of allowedWriteRoots) {
      const wrNorm = wr.replace(/\/$/, "")
      if (wrNorm !== wsNorm && wrNorm.startsWith(wsNorm + "/")) {
        const subdir = wrNorm.slice(wsNorm.length + 1)
        candidates.push(`${subdir}/${plannedPath}`)
      } else if (!wrNorm.startsWith("/") && wrNorm !== "." && wrNorm !== "./") {
        candidates.push(`${wrNorm}/${plannedPath}`)
      }
    }
  }

  // 1. Try planned path (and workspace-rooted variant)
  for (const candidate of candidates) {
    try {
      const content = await readFile.execute({ path: candidate })
      if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
        return { found: true, resolvedPath: candidate }
      }
    } catch { /* fall through */ }
  }

  // 2. Try to match against paths the child actually wrote
  const basename = plannedPath.split("/").pop() ?? plannedPath
  for (const actual of actualPaths) {
    if (actual === plannedPath || actual.endsWith(`/${plannedPath}`) || actual.endsWith(`/${basename}`)) {
      try {
        const content = await readFile.execute({ path: actual })
        if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
          return { found: true, resolvedPath: actual }
        }
      } catch { /* fall through */ }
    }
  }

  // 3. Last resort: search with find, scoped to workspaceRoot and excluding noise
  if (runCommand && basename) {
    try {
      const searchRoot = workspaceRoot || "."
      const findResult = await runCommand.execute({
        command: `find ${JSON.stringify(searchRoot)} -maxdepth 5 -name ${JSON.stringify(basename)} -type f -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.git/*" 2>/dev/null | head -5`,
      })
      const foundPaths = findResult.trim().split("\n").filter((p: string) => p.length > 0 && p !== "." && !p.includes("(no output)") && p.startsWith("/"))
      for (const fp of foundPaths) {
        const cleanPath = fp.replace(/^\.\//, "")
        try {
          const content = await readFile.execute({ path: cleanPath })
          if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
            return { found: true, resolvedPath: cleanPath }
          }
        } catch { /* fall through */ }
      }
    } catch { /* fall through */ }
  }

  return { found: false, resolvedPath: plannedPath }
}

/**
 * Run deterministic acceptance probes — file existence checks, build commands, etc.
 * Returns per-step assessments based on concrete evidence.
 */
export async function runDeterministicProbes(
  plan: Plan,
  pipelineResult: PipelineResult,
  tools: readonly Tool[],
): Promise<VerifierStepAssessment[]> {
  const assessments: VerifierStepAssessment[] = []
  const toolMap = new Map(tools.map(t => [t.name, t]))

  for (const step of plan.steps) {
    const stepResult = pipelineResult.stepResults.get(step.name)
    if (!stepResult || stepResult.status !== "completed") {
      assessments.push({
        stepName: step.name,
        outcome: stepResult?.status === "skipped" ? "fail" : "fail",
        confidence: 1.0,
        issues: [stepResult?.error ?? `Step ${step.name} did not complete`],
        retryable: true,
      })
      continue
    }

    if (step.stepType === "subagent_task") {
      const sa = step as SubagentTaskStep
      const issues: string[] = []
      const outputText = (stepResult.output ?? "").trim()

      // Extract actual file paths from child output for path resolution
      const actualPaths = extractActualPaths(outputText)

      // Check target artifacts exist (with path resolution fallback)
      // Cache probe results so content-completeness and browser_check can reuse them
      const readFile = toolMap.get("read_file")
      const runCommand = toolMap.get("run_command")
      const wsRoot = sa.executionContext.workspaceRoot || undefined
      const probeCache = new Map<string, { found: boolean; resolvedPath: string }>()
      if (readFile && sa.executionContext.targetArtifacts.length > 0) {
        for (const artifact of sa.executionContext.targetArtifacts) {
          const probe = await probeArtifact(readFile, artifact, actualPaths, wsRoot, runCommand, sa.executionContext.allowedWriteRoots)
          probeCache.set(artifact, probe)
          if (!probe.found) {
            issues.push(`Target artifact "${artifact}" not found`)
          }
        }
      }

      // If verification mode is browser_check, run it
      if (sa.executionContext.verificationMode === "browser_check") {
        const browserCheck = toolMap.get("browser_check")
        if (browserCheck) {
          const htmlArtifacts = sa.executionContext.targetArtifacts.filter(
            a => a.endsWith(".html") || a.endsWith(".htm"),
          )
          for (const html of htmlArtifacts) {
            // Reuse cached probe result; browser_check expects a RELATIVE path
            const cached = probeCache.get(html)
            let browserPath = cached?.found ? cached.resolvedPath : html
            // Strip workspace root prefix — browser_check joins cwd + path internally
            if (wsRoot && browserPath.startsWith(wsRoot)) {
              browserPath = browserPath.slice(wsRoot.length).replace(/^\//, "")
            }
            try {
              const result = await browserCheck.execute({ path: browserPath })
              if (/error|fail|exception/i.test(result) && !/no errors/i.test(result)) {
                issues.push(`Browser check for "${browserPath}" reported errors: ${result.slice(0, 300)}`)
              }
            } catch {
              issues.push(`Browser check failed for "${browserPath}"`)
            }
          }
        }
      }

      // If verification mode is run_tests, run the test command
      if (sa.executionContext.verificationMode === "run_tests") {
        const runCmd = toolMap.get("run_command")
        if (runCmd) {
          try {
            const result = await runCmd.execute({ command: "npm test 2>&1 || exit 0" })
            // Only flag real test failures ("X failed", "FAIL"), not incidental mentions of error/fail
            if (/\d+\s+fail|FAIL\s|tests?\s+failed/i.test(result) && !/0 failed/i.test(result)) {
              issues.push(`Test run reported failures: ${result.slice(0, 300)}`)
            }
          } catch {
            issues.push("Test run failed to execute")
          }
        }
      }

      // ── Content completeness probe — detect placeholder / skeleton / corrupted code ──
      if (readFile && sa.executionContext.targetArtifacts.length > 0) {
        const codeArtifacts = sa.executionContext.targetArtifacts.filter(
          a => /\.(js|jsx|ts|tsx|py|rb|java|cs|go|rs|c|cpp|swift|kt|php)$/i.test(a),
        )
        for (const artifact of codeArtifacts) {
          const cached = probeCache.get(artifact)
          if (!cached?.found) continue // already flagged by existence check
          try {
            const content = await readFile.execute({ path: cached.resolvedPath })
            if (typeof content === "string" && content.length > 0) {
              // Check for placeholder patterns
              const placeholders = detectPlaceholderPatterns(content)
              if (placeholders.length > 0) {
                issues.push(
                  `Placeholder/stub code in "${artifact}": ${placeholders.join("; ")}`,
                )
              }
              // Check for LLM degeneration / corrupted code
              const corruption = detectCodeCorruption(content)
              if (corruption.length > 0) {
                issues.push(
                  `Corrupted/degenerated code in "${artifact}": ${corruption.join("; ")}`,
                )
              }
            }
          } catch { /* already flagged */ }
        }

        // ── JavaScript syntax validation — run node --check on .js files ──
        if (runCommand) {
          const jsArtifacts = sa.executionContext.targetArtifacts.filter(
            a => /\.js$/i.test(a),
          )
          for (const artifact of jsArtifacts) {
            const cached = probeCache.get(artifact)
            if (!cached?.found) continue
            let checkPath = cached.resolvedPath
            // Ensure path is suitable for shell execution
            if (!checkPath.startsWith("/") && wsRoot) {
              checkPath = wsRoot.endsWith("/") ? `${wsRoot}${checkPath}` : `${wsRoot}/${checkPath}`
            }
            try {
              const result = await runCommand.execute({
                command: `node --check ${JSON.stringify(checkPath)} 2>&1`,
              })
              if (/SyntaxError|Unexpected token|Unexpected identifier/i.test(result)) {
                issues.push(`Syntax error in "${artifact}": ${result.trim().split("\n").slice(0, 3).join(" | ")}`)
              }
            } catch { /* non-critical */ }
          }
        }

        // ── HTML corruption detection ──
        const htmlArtifs = sa.executionContext.targetArtifacts.filter(
          a => /\.html?$/i.test(a),
        )
        for (const artifact of htmlArtifs) {
          const cached = probeCache.get(artifact)
          if (!cached?.found) continue
          try {
            const content = await readFile.execute({ path: cached.resolvedPath })
            if (typeof content === "string" && content.length > 0) {
              const htmlIssues = detectHtmlCorruption(content)
              if (htmlIssues.length > 0) {
                issues.push(
                  `Corrupted HTML in "${artifact}": ${htmlIssues.join("; ")}`,
                )
              }
            }
          } catch { /* already flagged */ }
        }
      }

      // ── Evidence density scoring (agenc-core pattern) ──
      const outputLower = outputText.toLowerCase()

      if (outputText.length > 0 && !EVIDENCE_DENSITY_RE.test(outputLower)) {
        issues.push("Weak evidence density: output lacks concrete indicators (file paths, line numbers, errors, data)")
      }

      // ── Hallucination detection (agenc-core pattern) ──
      if (
        outputText.length > 0 &&
        HALLUCINATION_CLAIM_RE.test(outputLower) &&
        !outputIntersectsArtifacts(outputLower, sa.executionContext.targetArtifacts)
      ) {
        issues.push("Hallucination risk: output references artifacts/logs but claims don't match known targets")
      }

      // ── Tool-call consistency check (agenc-core pattern) ──
      // If the step required tool capabilities but the child reported no tool usage,
      // it likely hallucinated or skipped actual execution.
      if (stepResult.output) {
        const parsedOutput = safeParseJson(stepResult.output)
        if (parsedOutput) {
          const toolCallCount = typeof parsedOutput.toolCalls === "number"
            ? parsedOutput.toolCalls
            : Array.isArray(parsedOutput.toolCalls) ? parsedOutput.toolCalls.length : -1
          const failedToolCallCount = typeof parsedOutput.failedToolCalls === "number"
            ? parsedOutput.failedToolCalls : 0

          if (toolCallCount === 0 && sa.executionContext.targetArtifacts.length > 0) {
            issues.push("Missing tool evidence: step required tool capabilities but reported zero tool calls")
          }
          if (toolCallCount > 0 && failedToolCallCount >= toolCallCount) {
            issues.push("All tool calls failed: child agent reported no successful tool executions")
          }
          if (parsedOutput.success === false || String(parsedOutput.status).toLowerCase() === "failed") {
            issues.push("Child agent reported explicit failure")
          }
        }
      }

      // ── Gibberish / word-salad detection ──
      if (outputText.length > 20) {
        const gibberishScore = computeGibberishScore(outputText)
        if (gibberishScore >= 0.6) {
          issues.push("Child output appears to be gibberish/word-salad — no coherent implementation summary")
        }
      }

      // ── Role-specific validation (agenc-core pattern) ──
      const role = sa.executionContext.role ?? "writer"
      if (role === "writer") {
        // Writer steps must actually produce files — verify they exist and have content
        let mutationConfirmed = false
        for (const artifact of sa.executionContext.targetArtifacts) {
          const cached = probeCache.get(artifact)
          if (cached?.found) {
            mutationConfirmed = true
            break
          }
        }
        if (!mutationConfirmed && sa.executionContext.targetArtifacts.length > 0) {
          if (!issues.some(i => i.includes("not found"))) {
            issues.push("Writer step may lack mutation evidence — target artifacts not found on disk")
          }
        }
      }

      // ── Confidence from issue count (agenc-core formula) ──
      const confidence = Math.max(0, 1 - Math.min(0.9, issues.length * 0.18))
      const outcome: VerifierOutcome = issues.length > 0
        ? (confidence < DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE ? "fail" : "retry")
        : "pass"

      assessments.push({
        stepName: step.name,
        outcome,
        confidence,
        issues,
        retryable: true,
      })
    } else {
      // Deterministic tool steps: if they completed, they pass
      assessments.push({
        stepName: step.name,
        outcome: "pass",
        confidence: 1.0,
        issues: [],
        retryable: false,
      })
    }
  }

  return assessments
}

// ============================================================================
// LLM-based verification
// ============================================================================

const VERIFIER_SYSTEM_PROMPT = `You are a strict verifier for delegated outputs and implementation runs.

Grade steps by role:
- Reviewer steps: pass when they produce grounded findings backed by reads/workspace inspection. Do NOT require file mutation from reviewers.
- Writer steps: pass ONLY when they mutate owned target artifacts or explicitly report a grounded no-op with current target-artifact evidence. Findings alone are insufficient for writers.
- Validator steps: must enforce implementation completion and reviewer-child completion before marking the workflow complete.

Assess: contract adherence, evidence quality, hallucination risk against provided artifacts, and whether work is complete.

You MUST respond with valid JSON matching this schema:
{
  "overall": "pass" | "retry" | "fail",
  "confidence": 0.85,
  "steps": [
    {
      "stepName": "step_name",
      "outcome": "pass" | "retry" | "fail",
      "confidence": 0.9,
      "issues": ["issue description"],
      "retryable": true
    }
  ],
  "unresolvedItems": ["any remaining concerns"]
}

Rules:
- "pass" means the step completed and produced REAL, WORKING implementation that meets the core objective
- "retry" means the step produced output but has clear, concrete deficiencies that a retry could fix
- "fail" means the step fundamentally failed (error, no output, wrong approach entirely)
- SKELETON / PLACEHOLDER CODE IS NEVER "pass": If a step was supposed to implement logic but output contains placeholder functions (\`return true\` as validation, empty bodies, \`// TODO\`, \`// Placeholder\`), mark it "retry" with specific issues listing what needs real implementation
- Be practical: if the step produced working output that meets the core objective, mark it as pass even if minor polish is possible
- Only mark "retry" for specific, actionable issues — not vague concerns about quality
- If deterministic probes passed for a step, strongly prefer "pass" unless you see a clear problem
- Evidence quality: outputs with concrete indicators (file paths, line numbers, error messages, data) are more trustworthy than vague summaries
- Hallucination check: if output claims "according to logs" or "as seen in" but doesn't match known artifacts, flag it
- confidence is 0.0 to 1.0
- Respond ONLY with the JSON object`

/**
 * Ask the LLM to assess plan execution results against acceptance criteria.
 */
export async function runLLMVerification(
  llm: LLMClient,
  plan: Plan,
  pipelineResult: PipelineResult,
  deterministicAssessments: readonly VerifierStepAssessment[],
  opts?: { signal?: AbortSignal; onTrace?: (entry: Record<string, unknown>) => void },
): Promise<VerifierDecision> {
  // Build verification context
  const stepSummaries = plan.steps.map(step => {
    const result = pipelineResult.stepResults.get(step.name)
    const detAssessment = deterministicAssessments.find(a => a.stepName === step.name)

    return {
      name: step.name,
      type: step.stepType,
      ...(step.stepType === "subagent_task" ? {
        objective: (step as SubagentTaskStep).objective,
        acceptanceCriteria: (step as SubagentTaskStep).acceptanceCriteria,
      } : {}),
      status: result?.status ?? "unknown",
      output: result?.output?.slice(0, 1000) ?? result?.error ?? "no output",
      deterministicResult: detAssessment ? {
        outcome: detAssessment.outcome,
        issues: detAssessment.issues,
      } : undefined,
    }
  })

  const messages: Message[] = [
    { role: "system", content: VERIFIER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Verify the following plan execution results:\n\nPlan reason: ${plan.reason}\n\nStep results:\n${JSON.stringify(stepSummaries, null, 2)}`,
    },
  ]

  // Emit llm-request trace so the UI can display the verifier prompt
  opts?.onTrace?.({
    kind: "llm-request",
    iteration: -1,
    messageCount: messages.length,
    toolCount: 0,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      toolCalls: [],
      toolCallId: null,
    })),
  })

  try {
    const t0 = Date.now()
    const response = await llm.chat(messages, [], { signal: opts?.signal })
    const durationMs = Date.now() - t0

    // Emit llm-response trace
    opts?.onTrace?.({
      kind: "llm-response",
      iteration: -1,
      durationMs,
      content: response.content,
      toolCalls: [],
      usage: response.usage ?? null,
    })

    if (!response.content) {
      return buildFallbackDecision(deterministicAssessments)
    }

    return parseLLMVerification(response.content, deterministicAssessments)
  } catch {
    // Fallback to deterministic-only assessment
    return buildFallbackDecision(deterministicAssessments)
  }
}

// ============================================================================
// Combined verification
// ============================================================================

/**
 * Full verification: deterministic probes + LLM assessment.
 * Returns a merged VerifierDecision.
 */
export async function verify(
  llm: LLMClient,
  plan: Plan,
  pipelineResult: PipelineResult,
  tools: readonly Tool[],
  opts?: { signal?: AbortSignal; onTrace?: (entry: Record<string, unknown>) => void },
): Promise<VerifierDecision> {
  // Phase 1: Deterministic probes
  const detAssessments = await runDeterministicProbes(plan, pipelineResult, tools)

  // If deterministic probes already show clear failure, skip LLM verification
  const detFails = detAssessments.filter(a => a.outcome === "fail" || a.outcome === "retry")
  if (detFails.length > 0 && detFails.some(a => a.outcome === "fail")) {
    return buildFallbackDecision(detAssessments)
  }

  // Phase 2: LLM verification
  const decision = await runLLMVerification(llm, plan, pipelineResult, detAssessments, { signal: opts?.signal, onTrace: opts?.onTrace })

  // Merge: if deterministic says "retry" but LLM says "pass", trust deterministic
  const mergedSteps = decision.steps.map(llmStep => {
    const detStep = detAssessments.find(d => d.stepName === llmStep.stepName)
    if (detStep && detStep.outcome !== "pass" && llmStep.outcome === "pass") {
      return { ...detStep } // deterministic issues override LLM optimism
    }
    return llmStep
  })

  const anyRetry = mergedSteps.some(s => s.outcome === "retry")
  const anyFail = mergedSteps.some(s => s.outcome === "fail")

  return {
    overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
    confidence: Math.min(decision.confidence, ...mergedSteps.map(s => s.confidence)),
    steps: mergedSteps,
    unresolvedItems: decision.unresolvedItems,
  }
}

// ============================================================================
// Helpers
// ============================================================================

function parseLLMVerification(
  raw: string,
  fallbackAssessments: readonly VerifierStepAssessment[],
): VerifierDecision {
  let jsonStr = raw.trim()
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1].trim()
  }

  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>

    const steps: VerifierStepAssessment[] = Array.isArray(obj.steps)
      ? (obj.steps as Array<Record<string, unknown>>).map(s => ({
          stepName: String(s.stepName ?? ""),
          outcome: parseOutcome(s.outcome),
          confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
          issues: Array.isArray(s.issues) ? s.issues.map(String) : [],
          retryable: Boolean(s.retryable ?? true),
        }))
      : [...fallbackAssessments]

    return {
      overall: parseOutcome(obj.overall),
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
      steps,
      unresolvedItems: Array.isArray(obj.unresolvedItems) ? obj.unresolvedItems.map(String) : [],
    }
  } catch {
    return buildFallbackDecision(fallbackAssessments)
  }
}

function parseOutcome(value: unknown): VerifierOutcome {
  const s = String(value ?? "")
  if (s === "pass" || s === "retry" || s === "fail") return s
  return "pass" // default to pass on ambiguity — avoid pointless retries
}

function buildFallbackDecision(
  assessments: readonly VerifierStepAssessment[],
): VerifierDecision {
  const anyFail = assessments.some(a => a.outcome === "fail")
  const anyRetry = assessments.some(a => a.outcome === "retry")
  const allIssues = assessments.flatMap(a => a.issues)

  return {
    overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
    confidence: Math.min(1.0, ...assessments.map(a => a.confidence)),
    steps: [...assessments],
    unresolvedItems: allIssues,
  }
}

// ============================================================================
// Content completeness helpers
// ============================================================================

/** Patterns that indicate skeleton / placeholder code that is not real implementation. */
const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string; contextRe?: RegExp }> = [
  // Explicit stubs
  { re: /\/\/\s*(?:placeholder|todo|fixme|implement|stub)\b/gi, label: "placeholder comment" },
  { re: /\/\*\s*(?:placeholder|todo|fixme|implement|stub)\b/gi, label: "placeholder comment" },
  { re: /#\s*(?:placeholder|todo|fixme|implement|stub)\b/gi, label: "placeholder comment" },
  // Trivially-returning validation functions — only flag when function name suggests
  // it should validate/check/compute something
  {
    re: /function\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+)\s*\([^)]*\)\s*\{[\s\n]*return\s+(true|false)\s*;?\s*\}/gi,
    label: "validation function always returns constant",
  },
  // Arrow function variant
  {
    re: /(?:const|let|var)\s+(is\w+|validate\w*|check\w*|compute\w*|calculate\w*|can\w+)\s*=\s*\([^)]*\)\s*=>\s*(true|false)\s*;?/gi,
    label: "validation function always returns constant",
  },
  // Empty function bodies (function with only whitespace/comments inside)
  {
    re: /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:function|\([^)]*\)\s*=>))\s*\([^)]*\)\s*\{[\s\n]*(?:\/\/[^\n]*[\s\n]*)*\}/gi,
    label: "empty function body",
  },
]

/**
 * Scan source code for placeholder / stub patterns.
 * Returns a list of human-readable findings, at most 5.
 */
function detectPlaceholderPatterns(code: string): string[] {
  const findings: string[] = []
  for (const { re, label } of PLACEHOLDER_PATTERNS) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0
    const matches = code.match(re)
    if (matches && matches.length > 0) {
      // Only report the first match  snippet (truncated) to keep it actionable
      const snippet = matches[0].replace(/\n/g, " ").trim().slice(0, 80)
      findings.push(`${label} (${matches.length}x) e.g. "${snippet}"`)
    }
    if (findings.length >= 5) break
  }
  return findings
}

/**
 * Heuristic to detect word-salad / gibberish output from child agents.
 * Returns a score 0..1 where higher = more likely gibberish.
 *
 * Signals:
 *  - Very few sentence-ending punctuation relative to word count
 *  - High ratio of capitalized mid-sentence words (jargon mashup)
 *  - Contains compound-hyphenated nonsense words
 *  - Very few common English function words (the, is, a, and, to)
 */
function computeGibberishScore(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0)
  if (words.length < 5) return 0

  let score = 0
  const wordCount = words.length

  // Signal 1: Compound-hyphenated words that look like jargon mashup
  const compoundJargon = text.match(/[a-z]+-[a-z]+-[a-z]+/gi) ?? []
  if (compoundJargon.length >= 2) score += 0.3

  // Signal 2: Very few function words (the, is, a, and, to, of, in, for, with, that)
  const functionWordRe = /\b(the|is|a|an|and|to|of|in|for|with|that|was|were|has|have|it|this|are)\b/gi
  const functionWordCount = (text.match(functionWordRe) ?? []).length
  const functionWordRatio = functionWordCount / wordCount
  if (functionWordRatio === 0 && wordCount >= 8) score += 0.4
  else if (functionWordRatio < 0.05) score += 0.3

  // Signal 3: Sentence-ending punctuation count vs word count
  const sentenceEnders = (text.match(/[.!?]\s/g) ?? []).length + (text.endsWith(".") || text.endsWith("!") || text.endsWith("?") ? 1 : 0)
  if (sentenceEnders === 0 && wordCount >= 8) score += 0.2

  // Signal 4: Contains no file paths or code indicators (for agent output, this is suspicious)
  const hasCodeIndicators = /[/\\]|\.(?:js|ts|html|css|py)\b|`[^`]+`|\bfunction\b|\bclass\b|\bconst\b/i.test(text)
  if (!hasCodeIndicators && wordCount >= 8) score += 0.2

  return Math.min(1, score)
}

// ============================================================================
// Code corruption / LLM degeneration detection
// ============================================================================

/**
 * Detect LLM degeneration in code files.
 * When a model degenerates mid-output, you get things like:
 *   `}valuator move saftey can ahead validated, letinline acknowledge`
 *   `// Rooks dx or /dy condition stric validation for attack`
 * These are NOT valid code and NOT valid comments — they're word-salad mixed into code.
 *
 * Returns a list of findings (empty = clean).
 */
function detectCodeCorruption(code: string): string[] {
  const findings: string[] = []
  const lines = code.split("\n")

  // Signal 1: Lines that look like broken code — closing brace/paren followed by
  // random English words that don't form valid code
  const brokenCodeRe = /[})\]]\s*[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i
  let brokenLineCount = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length > 10 && brokenCodeRe.test(trimmed)) {
      // Make sure it's not a legit comment or string
      if (!trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("#")) {
        brokenLineCount++
      }
    }
  }
  if (brokenLineCount > 0) {
    findings.push(`${brokenLineCount} line(s) with code-mixed-with-gibberish (LLM degeneration)`)
  }

  // Signal 2: Non-ASCII-art noise in code (random symbols + words that don't form expressions)
  // Pattern: semicolons, slashes or dots in contexts that don't make sense as code
  const nonsenseTokenRe = /\b[a-z]+(?:\/[a-z])+\b/gi // e.g. "othered.scope/s"
  const nonsenseMatches = code.match(nonsenseTokenRe) ?? []
  // Filter out legitimate paths (contain common path components)
  const suspiciousNonsense = nonsenseMatches.filter(m =>
    !SOURCE_LIKE_PATH_RE.test(m) && m.length > 3
  )
  if (suspiciousNonsense.length >= 2) {
    findings.push(`Suspicious word/symbol fragments: "${suspiciousNonsense.slice(0, 3).join('", "')}"`)
  }

  // Signal 3: Abrupt file ending — code file that ends without proper closure
  // (missing closing braces, or ends mid-expression)
  const lastMeaningfulLine = lines.filter(l => l.trim().length > 0).pop()?.trim() ?? ""
  if (
    code.length > 100 &&
    lastMeaningfulLine.length > 0 &&
    !lastMeaningfulLine.endsWith("}") &&
    !lastMeaningfulLine.endsWith(";") &&
    !lastMeaningfulLine.endsWith(")") &&
    !lastMeaningfulLine.endsWith("*/") &&
    !lastMeaningfulLine.endsWith("`") &&
    !/^(?:export|module\.exports|\/\/)/i.test(lastMeaningfulLine)
  ) {
    // Check brace balance too
    const opens = (code.match(/{/g) ?? []).length
    const closes = (code.match(/}/g) ?? []).length
    if (opens > closes + 1) {
      findings.push(`File appears truncated/corrupted: ${opens - closes} unclosed brace(s), ends with "${lastMeaningfulLine.slice(-60)}"`)
    }
  }

  return findings
}

/**
 * Detect corruption patterns specific to HTML files.
 * LLM degeneration in HTML looks like:
 *   `<div id="capture-black_white_notes;letRs}>`
 * Semicolons, braces, and random tokens inside HTML attribute values.
 */
function detectHtmlCorruption(html: string): string[] {
  const findings: string[] = []

  // Signal 1: HTML attributes with code garbage in values (properly quoted)
  // Match attribute values containing semicolons, braces, or JS-like tokens
  const corruptAttrRe = /\w+="[^"]*[{};][^"]*"/g
  const corruptAttrs = html.match(corruptAttrRe) ?? []
  // Filter out legitimate CSS inline styles which can contain semicolons
  const suspiciousAttrs = corruptAttrs.filter(a => {
    if (/^style="/i.test(a)) return false // CSS inline styles are OK
    return true
  })
  if (suspiciousAttrs.length > 0) {
    findings.push(`Corrupted HTML attribute(s): ${suspiciousAttrs.slice(0, 3).map(a => `"${a.slice(0, 60)}"`).join(", ")}`)
  }

  // Signal 2: Unclosed attribute values — opening quote never closed before tag end or newline
  // e.g. id="capture-black_white_notes;letRs}>
  const unclosedAttrRe = /\w+="[^"]{10,}(?:>|\n|$)/gm
  const unclosedAttrs = html.match(unclosedAttrRe) ?? []
  if (unclosedAttrs.length > 0) {
    findings.push(`Unclosed HTML attribute value(s): ${unclosedAttrs.slice(0, 3).map(a => `"${a.trim().slice(0, 60)}"`).join(", ")}`)
  }

  // Signal 3: Tags that never close properly (degeneration mid-tag)
  const unclosedTagRe = /<\w+[^>]*(?:\n[^>]*){5,}/g
  if (unclosedTagRe.test(html)) {
    findings.push("HTML tag spans 5+ lines without closing — possible degeneration")
  }

  // Signal 4: Brace balance in <script> or <style> blocks
  const scriptBlocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) ?? []
  for (const block of scriptBlocks) {
    const inner = block.replace(/<\/?script[^>]*>/gi, "")
    const corruption = detectCodeCorruption(inner)
    if (corruption.length > 0) {
      findings.push(`Embedded <script> has corrupted code: ${corruption[0]}`)
    }
  }

  return findings
}

// ============================================================================
// Evidence & hallucination helpers (ported from agenc-core)
// ============================================================================

/**
 * Check if output text intersects with known artifact paths.
 * If the output references things not in the artifact list, it may be hallucinated.
 */
function outputIntersectsArtifacts(outputLower: string, artifacts: readonly string[]): boolean {
  if (artifacts.length === 0) return true // no artifacts to check against
  return artifacts.some(artifact => {
    const normalizedArtifact = artifact.toLowerCase().replace(/^\.\//, "")
    // Check if any basename or partial path from the artifact appears in output
    const basename = normalizedArtifact.split("/").pop() ?? normalizedArtifact
    return outputLower.includes(basename) || outputLower.includes(normalizedArtifact)
  })
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
