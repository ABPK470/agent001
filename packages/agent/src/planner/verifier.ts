/**
 * Verifier — post-pipeline verification of execution results.
 *
 * Two-phase verification (agenc-core pattern):
 *   1. Deterministic probes — check file existence, run build/test commands
 *   2. LLM-based assessment — structured confidence check per step
 *
 * @module
 */

import { detectPlaceholderPatterns } from "../code-quality.js"
import {
  buildContractSpec,
  getCorrectionGuidance,
  validateDelegatedOutputContract
} from "../delegation-validation.js"
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
  // Match "created/wrote/modified [to] <path>" patterns — the optional "to" is
  // critical because tool output says "Successfully wrote to tmp/chess/game.js"
  for (const m of output.matchAll(/(?:creat|writ|wrote|modif|generat|saved)\w*\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
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
      // Accept both absolute and relative paths from find ("./tmp/file.js")
      const foundPaths = findResult.trim().split("\n")
        .filter((p: string) => p.length > 0 && p !== "." && !p.includes("(no output)"))
        .map((p: string) => p.replace(/^\.\//,  ""))
      for (const fp of foundPaths) {
        try {
          const content = await readFile.execute({ path: fp })
          if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
            return { found: true, resolvedPath: fp }
          }
        } catch { /* fall through */ }
      }
    } catch { /* fall through */ }
  }

  // 4. Second-chance find with relative "." as search root — catches cases where
  //    the absolute-path find returns no output due to CWD/sandbox differences.
  if (runCommand && basename) {
    try {
      const findResult2 = await runCommand.execute({
        command: `find . -maxdepth 6 -name ${JSON.stringify(basename)} -type f -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -5`,
      })
      const foundPaths2 = findResult2.trim().split("\n")
        .filter((p: string) => p.length > 0 && p !== "." && !p.includes("(no output)"))
        .map((p: string) => p.replace(/^\.\//,  ""))
      for (const fp of foundPaths2) {
        try {
          const content = await readFile.execute({ path: fp })
          if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
            return { found: true, resolvedPath: fp }
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

      // ── Path mismatch detection ──
      // When probeArtifact found a file, but at a DIFFERENT path than planned,
      // the child wrote to the wrong directory.  This is critical: the HTML
      // loads scripts from the planned path, so the code at the wrong path is
      // effectively dead.  Normalise paths to strip workspace root prefix
      // before comparison so "tmp/game.js" and "./tmp/game.js" are equivalent.
      for (const [artifact, probe] of probeCache) {
        if (!probe.found) continue
        const normPlanned = artifact.replace(/^\.\//, "")
        const normResolved = probe.resolvedPath.replace(/^\.\//, "")
        if (normResolved !== normPlanned) {
          // Strip wsRoot prefix from both sides for comparison
          const stripped = wsRoot
            ? normResolved.replace(new RegExp(`^${wsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "")
            : normResolved
          if (stripped !== normPlanned) {
            issues.push(
              `PATH MISMATCH: artifact "${artifact}" was found at "${probe.resolvedPath}" instead of the planned path. ` +
              `The child wrote to the WRONG directory. HTML and other files reference the planned path, so this file will NOT be loaded. ` +
              `The child must write to the EXACT path specified in targetArtifacts.`
            )
          }
        }
      }

      // ── Off-target write detection ──
      // Check if the child wrote to files NOT in its targetArtifacts.
      // This catches scope explosion (e.g. HTML step creating placeholder JS files).
      const targetSet = new Set(sa.executionContext.targetArtifacts.map(a => a.replace(/^\.\//, "")))
      for (const actual of actualPaths) {
        const normActual = actual.replace(/^\.\//, "")
        // Strip workspace root prefix for comparison
        const stripped = wsRoot
          ? normActual.replace(new RegExp(`^${wsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "")
          : normActual
        if (!targetSet.has(stripped) && !targetSet.has(normActual)) {
          // Only flag if this is a file owned by a DIFFERENT step
          const ownedByOtherStep = plan.steps.some(s => {
            if (s.name === step.name || s.stepType !== "subagent_task") return false
            const other = s as SubagentTaskStep
            return other.executionContext.targetArtifacts.some(
              a => a.replace(/^\.\//, "") === stripped || a.replace(/^\.\//, "") === normActual
            )
          })
          if (ownedByOtherStep) {
            issues.push(
              `SCOPE VIOLATION: Child wrote to "${actual}" which belongs to a DIFFERENT step's targetArtifacts. ` +
              `Each step must ONLY write to its own target files. Writing to other steps' files causes overwrites and data loss.`
            )
          }
        }
      }

      // If verification mode is browser_check, run it
      let browserCheckPassed = false
      if (sa.executionContext.verificationMode === "browser_check") {
        const browserCheck = toolMap.get("browser_check")
        if (browserCheck) {
          const htmlArtifacts = sa.executionContext.targetArtifacts.filter(
            a => a.endsWith(".html") || a.endsWith(".htm"),
          )
          let anyBrowserFailure = false
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
                anyBrowserFailure = true
              }
            } catch {
              issues.push(`Browser check failed for "${browserPath}"`)
              anyBrowserFailure = true
            }
          }
          if (htmlArtifacts.length > 0 && !anyBrowserFailure) {
            browserCheckPassed = true
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
              // Check for unresolved method references (this.foo() where foo is not defined)
              // This catches destructive rewrites where a child agent removes functions
              // that are still called from other methods in the same file.
              if (/\bclass\b/.test(content)) {
                const unresolvedMethods = detectUnresolvedMethods(content)
                if (unresolvedMethods.length > 0) {
                  issues.push(
                    `Missing method(s) in "${artifact}": ${unresolvedMethods.join("; ")}`,
                  )
                }
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
              // Skip MODULE_NOT_FOUND — means the file path doesn't exist on
              // the actual filesystem (e.g. sandbox/virtual FS paths).  Only
              // flag genuine syntax errors.
              if (
                /SyntaxError|Unexpected token|Unexpected identifier/i.test(result) &&
                !/MODULE_NOT_FOUND|Cannot find module/i.test(result)
              ) {
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

      // ── Functional complexity heuristic ──
      // A step with many acceptance criteria needs substantial code.  If ALL
      // code artifacts together are under a very low threshold, flag it.
      // Multiplier kept conservative (8 lines/criterion) to avoid false
      // positives on compact but correct implementations.
      if (readFile && sa.acceptanceCriteria.length >= 5) {
        let totalCodeLines = 0
        for (const artifact of sa.executionContext.targetArtifacts) {
          const cached = probeCache.get(artifact)
          if (!cached?.found) continue
          if (!/\.(js|jsx|ts|tsx|py|rb|java|cs|go|rs|c|cpp|swift|kt|php)$/i.test(artifact)) continue
          try {
            const content = await readFile.execute({ path: cached.resolvedPath })
            if (typeof content === "string") {
              totalCodeLines += content.split("\n").filter(l => l.trim().length > 0 && !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*")).length
            }
          } catch { /* skip */ }
        }
        // Conservative heuristic: ~8 meaningful lines per acceptance criterion.
        // Only flags truly skeletal code — compact implementations are fine.
        const minExpectedLines = sa.acceptanceCriteria.length * 8
        if (totalCodeLines > 0 && totalCodeLines < minExpectedLines) {
          issues.push(
            `Implementation appears skeletal: ${totalCodeLines} non-comment code lines for ${sa.acceptanceCriteria.length} acceptance criteria (expected at least ${minExpectedLines}). The code likely lacks real logic for most criteria.`,
          )
        }
      }

      // ── Acceptance criteria ↔ code evidence check ──
      // For each acceptance criterion, extract distinctive keywords and verify
      // at least one appears somewhere in the code artifacts.  If none of a
      // criterion's keywords are found, the feature is likely unimplemented —
      // even if the child claims otherwise.
      if (readFile && sa.acceptanceCriteria.length > 0) {
        // Gather all code content (already read by earlier probes — reuse probeCache)
        let allCode = ""
        for (const artifact of sa.executionContext.targetArtifacts) {
          const cached = probeCache.get(artifact)
          if (!cached?.found) continue
          try {
            const content = await readFile.execute({ path: cached.resolvedPath })
            if (typeof content === "string") allCode += "\n" + content
          } catch { /* skip */ }
        }

        if (allCode.length > 0) {
          const codeLower = allCode.toLowerCase()
          const missingCriteria: string[] = []

          for (const criterion of sa.acceptanceCriteria) {
            const keywords = extractCriterionKeywords(criterion)
            if (keywords.length === 0) continue
            // A criterion is "covered" if at least one of its keywords appears in code
            const covered = keywords.some(kw => codeLower.includes(kw))
            if (!covered) {
              missingCriteria.push(`"${criterion.slice(0, 80)}" (expected: ${keywords.join(", ")})`)
            }
          }

          if (missingCriteria.length > 0) {
            issues.push(
              `Acceptance criteria with no code evidence (${missingCriteria.length}/${sa.acceptanceCriteria.length}): ` +
              missingCriteria.slice(0, 5).join("; "),
            )
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
      // Structural issues are blockers (stubs, corruption, syntax errors, missing files).
      // Non-structural issues (evidence density, line count, hallucination risk) are
      // informational — they should NOT trigger retries when browser_check passed and
      // no structural problems exist, because retries risk destroying working code.
      const STRUCTURAL_KEYWORDS = [
        "not found", "Placeholder", "stub", "Syntax error", "Corrupted",
        "Missing method", "Browser check", "catch-all", "empty function",
        "deferred-work", "explicit failure", "all tool calls failed",
        "zero tool calls", "gibberish", "skeletal", "inconsistent branch",
        "degeneration", "no code evidence", "PATH MISMATCH", "SCOPE VIOLATION",
      ]
      const structuralIssues = issues.filter(i =>
        STRUCTURAL_KEYWORDS.some(kw => i.toLowerCase().includes(kw.toLowerCase())),
      )
      const nonStructuralIssues = issues.filter(i =>
        !STRUCTURAL_KEYWORDS.some(kw => i.toLowerCase().includes(kw.toLowerCase())),
      )

      // If browser_check passed and all artifacts exist and no structural issues,
      // the code is working — don't let non-structural concerns trigger a retry
      // that could destroy it.
      let effectiveIssueCount = issues.length
      if (browserCheckPassed && structuralIssues.length === 0) {
        effectiveIssueCount = 0 // all remaining issues are non-structural → code is working
      } else if (browserCheckPassed && structuralIssues.length < issues.length) {
        // Browser works but has some structural issues — only count those
        effectiveIssueCount = structuralIssues.length
      }

      const confidence = Math.max(0, 1 - Math.min(0.9, effectiveIssueCount * 0.18))
      const outcome: VerifierOutcome = effectiveIssueCount > 0
        ? (confidence < DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE ? "fail" : "retry")
        : "pass"

      assessments.push({
        stepName: step.name,
        outcome,
        confidence,
        issues: effectiveIssueCount < issues.length
          ? [...structuralIssues, ...nonStructuralIssues.map(i => `[non-blocking] ${i}`)]
          : issues,
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

  // ── Cross-step integration probe ──
  // After all per-step probes, check that artifacts across steps integrate properly.
  // This catches: HTML missing <script> tags for JS files, cross-file window.X references
  // to unexported symbols, etc.
  await runIntegrationProbes(plan, pipelineResult, toolMap, assessments)

  return assessments
}

// ============================================================================
// Cross-step integration probes
// ============================================================================

/**
 * Check that artifacts produced by different steps integrate with each other.
 * Detects: HTML files missing <script> tags for JS artifacts, cross-file
 * window.X references to symbols that no file exports.
 */
async function runIntegrationProbes(
  plan: Plan,
  _pipelineResult: PipelineResult,
  toolMap: Map<string, Tool>,
  assessments: VerifierStepAssessment[],
): Promise<void> {
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  // Collect ALL target artifacts and their owning step across the plan
  const allArtifacts: Array<{ path: string; stepName: string }> = []
  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    for (const artifact of sa.executionContext.targetArtifacts) {
      allArtifacts.push({ path: artifact, stepName: step.name })
    }
  }

  const htmlArtifacts = allArtifacts.filter(a => /\.html?$/i.test(a.path))
  const jsArtifacts = allArtifacts.filter(a => /\.js$/i.test(a.path))

  // No HTML+JS combination → nothing to check
  if (htmlArtifacts.length === 0 || jsArtifacts.length === 0) return

  // Read each HTML file and check for <script> tags referencing the JS artifacts
  for (const htmlEntry of htmlArtifacts) {
    const wsRoot = findWsRootForStep(plan, htmlEntry.stepName)
    const probe = await probeArtifact(readFile, htmlEntry.path, [], wsRoot, runCommand)
    if (!probe.found) continue

    let htmlContent: string
    try {
      const raw = await readFile.execute({ path: probe.resolvedPath })
      if (typeof raw !== "string" || raw.length === 0) continue
      htmlContent = raw
    } catch { continue }

    // Find JS files that should be loaded by this HTML
    // Only check JS artifacts from the same project (same directory tree)
    const htmlDir = htmlEntry.path.replace(/[^/]+$/, "")
    const relatedJs = jsArtifacts.filter(js => {
      const jsDir = js.path.replace(/[^/]+$/, "")
      // Same directory tree: either same dir or one is a subdirectory of the other
      return jsDir.startsWith(htmlDir) || htmlDir.startsWith(jsDir)
    })

    if (relatedJs.length === 0) continue

    const missingScripts: string[] = []
    for (const jsEntry of relatedJs) {
      const jsBasename = jsEntry.path.split("/").pop() ?? jsEntry.path
      // Check both src="filename.js" and src="./subdir/filename.js" patterns
      const hasScriptTag = htmlContent.includes(jsBasename) &&
        /<script\b[^>]*src\s*=\s*["'][^"']*/.test(htmlContent)
      if (!hasScriptTag) {
        missingScripts.push(jsBasename)
      }
    }

    if (missingScripts.length > 0) {
      // Find the assessment for the HTML-owning step and replace it with integration issue
      const idx = assessments.findIndex(a => a.stepName === htmlEntry.stepName)
      const issue = `Integration gap: HTML file "${htmlEntry.path}" has no <script> tags for JS files: ${missingScripts.join(", ")}. The JavaScript will never load.`
      if (idx >= 0) {
        const existing = assessments[idx]
        assessments[idx] = {
          stepName: existing.stepName,
          outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
          confidence: existing.outcome === "pass" ? 0.4 : existing.confidence,
          issues: [...existing.issues, issue],
          retryable: true,
        }
      }
    }
  }
}

/** Find workspace root for a given step name. */
function findWsRootForStep(plan: Plan, stepName: string): string | undefined {
  const step = plan.steps.find(s => s.name === stepName)
  if (step?.stepType === "subagent_task") {
    return (step as SubagentTaskStep).executionContext.workspaceRoot || undefined
  }
  return undefined
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
- LLM DEGENERATION IS NEVER "pass": Comments like \`// Other code as per existing logic\`, \`// rest of the code here\`, \`// same as above\`, \`// ... remaining\` mean the LLM skipped generating the actual code. Functions containing such comments are EMPTY STUBS even if they have some boilerplate around them. Check that functions have REAL algorithmic bodies, not just setup + degeneration comment + return.
- SHALLOW IMPLEMENTATION IS NEVER "pass": If the acceptance criteria require complex logic (e.g. piece movement rules, validation, game state management) but the code only has trivial/generic implementations (e.g. a movePiece function that doesn't validate piece-specific movement, a highlightLegalMoves that doesn't check actual legal moves), mark it "retry". READ THE ACTUAL CODE carefully — don't trust the child's self-reported summary.
- CODE LENGTH IS NOT A QUALITY METRIC: Compact, correct code is FINE. A 50-line file that correctly implements all acceptance criteria is better than a 300-line file with stubs. Judge by correctness and completeness, NOT by line count.
- When "Actual File Contents" are provided below the step results, YOU MUST read the actual code and verify EACH acceptance criterion is implemented with REAL logic. A function that exists but does the wrong thing is NOT passing.
- GUARD ORDERING: Check that early-return guards in event handlers or dispatchers don't block valid interactions. Example: \`if (item.owner !== currentUser) return;\` at the top of a click handler prevents clicking on opponent items to interact with them (e.g. capture). The guard should be conditional on current state (e.g. only reject when no item is already selected).
- HELPER FUNCTION TRACING: For each key acceptance criterion, identify the function(s) that implement it and the helpers they call. Pick ONE concrete scenario and mentally trace the code path step by step, including into helper functions. Verify each helper returns the correct value for that scenario. A helper whose name implies a semantic (e.g. "isSameTeam", "isValid", "hasPermission", "belongsTo") must actually implement that semantic correctly — don't assume it works just because it has a body. Pay special attention to comparisons that erase important distinctions (e.g. case-insensitive comparison on data where case carries meaning).
- MISSING FEATURE DETECTION: For each acceptance criterion, verify there is ACTUAL CODE implementing it — not just a function with a matching name, but real logic. If a criterion requires "checkmate detection" but no function traces king escape squares, that criterion is NOT met. If a criterion requires "en passant" but no code tracks the previous move's double-step, it is NOT met. List every criterion that is NOT implemented.
- Be practical: if the step produced working output that meets the core objective, mark it as pass even if minor polish is possible
- Only mark "retry" for specific, actionable issues — not vague concerns about quality
- If deterministic probes passed for a step, strongly prefer "pass" unless you see a clear problem in the actual code
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
  opts?: { signal?: AbortSignal; onTrace?: (entry: Record<string, unknown>) => void; artifactContents?: ReadonlyMap<string, string> },
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

  // Build artifact content section for code files so the LLM can assess
  // whether the code actually implements the acceptance criteria
  let artifactSection = ""
  if (opts?.artifactContents && opts.artifactContents.size > 0) {
    const parts: string[] = []
    for (const [path, content] of opts.artifactContents) {
      // Dynamic truncation: fewer artifacts → more space per file.
      // Single artifact gets 12k chars (enough for ~300 lines).
      // Many artifacts share a 24k total budget.
      const totalBudget = 24_000
      const perArtifactLimit = Math.max(4000, Math.floor(totalBudget / opts.artifactContents.size))
      const truncated = content.length > perArtifactLimit
        ? content.slice(0, perArtifactLimit) + `\n... (truncated, ${content.length} chars total)`
        : content
      parts.push(`### ${path}\n\`\`\`\n${truncated}\n\`\`\``)
    }
    artifactSection = `\n\n## Actual File Contents\nReview these carefully against the acceptance criteria:\n\n${parts.join("\n\n")}`
  }

  const messages: Message[] = [
    { role: "system", content: VERIFIER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Verify the following plan execution results:\n\nPlan reason: ${plan.reason}\n\nStep results:\n${JSON.stringify(stepSummaries, null, 2)}${artifactSection}`,
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
  // Phase 0: Delegation output contract validation
  // Fast, deterministic checks on child output structure + tool evidence.
  // These catch empty outputs, missing file mutations, contradictory claims, etc.
  // BEFORE spending tokens on LLM verification.
  const contractFailures: VerifierStepAssessment[] = []
  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const stepResult = pipelineResult.stepResults.get(step.name)
    if (!stepResult || stepResult.status === "skipped") continue

    const contractSpec = buildContractSpec(
      sa,
      sa.executionContext,
    )
    const contractResult = validateDelegatedOutputContract({
      spec: contractSpec,
      output: stepResult.output ?? stepResult.error ?? "",
      toolCalls: stepResult.toolCalls,
    })

    if (!contractResult.ok && contractResult.code) {
      const guidance = getCorrectionGuidance(contractResult.code)
      contractFailures.push({
        stepName: step.name,
        outcome: "retry",
        confidence: 0.95, // high confidence — deterministic check
        issues: [
          `[contract:${contractResult.code}] ${contractResult.message}`,
          `[correction] ${guidance}`,
        ],
        retryable: true,
      })
      opts?.onTrace?.({
        kind: "verifier-contract-check",
        stepName: step.name,
        code: contractResult.code,
        message: contractResult.message,
      })
    }
  }

  // If contract validation caught issues, return immediately (no LLM needed)
  if (contractFailures.length > 0) {
    // Merge contract failures with pass assessments for steps that passed
    const allSteps: VerifierStepAssessment[] = []
    for (const step of plan.steps) {
      if (step.stepType !== "subagent_task") continue
      const contractFail = contractFailures.find(cf => cf.stepName === step.name)
      if (contractFail) {
        allSteps.push(contractFail)
      } else {
        const sr = pipelineResult.stepResults.get(step.name)
        if (sr && sr.status === "completed") {
          allSteps.push({ stepName: step.name, outcome: "pass", confidence: 0.8, issues: [], retryable: false })
        }
      }
    }
    return {
      overall: "retry",
      confidence: Math.min(...allSteps.map(s => s.confidence)),
      steps: allSteps,
      unresolvedItems: contractFailures.map(cf => cf.issues[0]),
    }
  }

  // Phase 1: Deterministic probes
  const detAssessments = await runDeterministicProbes(plan, pipelineResult, tools)

  // If deterministic probes already show clear failure, skip LLM verification
  const detFails = detAssessments.filter(a => a.outcome === "fail" || a.outcome === "retry")
  if (detFails.length > 0 && detFails.some(a => a.outcome === "fail")) {
    return buildFallbackDecision(detAssessments)
  }

  // Read actual file contents for code artifacts to give the LLM verifier
  // concrete code to assess (not just the child's self-reported output).
  // Use probeArtifact for path resolution — the planned paths are often bare
  // filenames (e.g. "gameLogic.js") but the actual files live in subdirectories
  // (e.g. "tmp/chess/gameLogic.js"). Without resolution the LLM verifier
  // gets zero code context and cannot assess quality.
  const artifactContents = new Map<string, string>()
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (readFile) {
    for (const step of plan.steps) {
      if (step.stepType !== "subagent_task") continue
      const sa = step as SubagentTaskStep
      // Gather actual paths from child output for better probe resolution
      const stepResult = pipelineResult.stepResults.get(step.name)
      const actualPaths = stepResult?.output ? extractActualPaths(stepResult.output) : []
      for (const artifact of sa.executionContext.targetArtifacts) {
        if (!/\.(js|jsx|ts|tsx|html|css|py)$/i.test(artifact)) continue
        const probe = await probeArtifact(
          readFile, artifact, actualPaths,
          sa.executionContext.workspaceRoot || undefined,
          runCommand,
          sa.executionContext.allowedWriteRoots,
        )
        if (probe.found) {
          try {
            const content = await readFile.execute({ path: probe.resolvedPath })
            if (typeof content === "string" && content.length > 0 && !content.startsWith("Error:")) {
              artifactContents.set(artifact, content)
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  // Phase 2: LLM verification
  const decision = await runLLMVerification(llm, plan, pipelineResult, detAssessments, { signal: opts?.signal, onTrace: opts?.onTrace, artifactContents })

  // Merge: if deterministic says "retry" but LLM says "pass", trust deterministic
  // UNLESS the deterministic outcome was upgraded from non-structural issues only
  // (i.e., all issues are prefixed [non-blocking]). In that case, the LLM's
  // "pass" is trustworthy — the code works (browser_check passed), and forcing
  // a retry risks destroying working code.
  const mergedSteps = decision.steps.map(llmStep => {
    const detStep = detAssessments.find(d => d.stepName === llmStep.stepName)
    if (detStep && detStep.outcome !== "pass" && llmStep.outcome === "pass") {
      // Check if all deterministic issues are non-blocking
      const allNonBlocking = detStep.issues.every(i => i.startsWith("[non-blocking]"))
      if (allNonBlocking && detStep.issues.length > 0) {
        // LLM says pass + deterministic issues are all non-blocking → trust LLM
        return { ...llmStep, issues: [...llmStep.issues, ...detStep.issues] }
      }
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
      ? (obj.steps as Array<Record<string, unknown>>).map(s => {
          // Filter out gibberish issues — the verifier LLM sometimes degenerates
          // and produces word-salad that would confuse retry children.
          const rawIssues: string[] = Array.isArray(s.issues) ? s.issues.map(String) : []
          const cleanIssues = rawIssues.filter(i => !isLLMGibberish(i))

          return {
            stepName: String(s.stepName ?? ""),
            outcome: parseOutcome(s.outcome),
            confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
            issues: cleanIssues,
            retryable: Boolean(s.retryable ?? true),
          }
        })
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
// Content completeness helpers — imported from ../code-quality.ts
// (detectPlaceholderPatterns, detectCatchAllReturns, PLACEHOLDER_PATTERNS)
// ============================================================================

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
// Method reference integrity check
// ============================================================================

/**
 * Common built-in methods that should not be flagged as unresolved.
 * Covers JS/TS Object, Array, String, Math, and common DOM methods.
 */
const BUILTIN_METHODS = new Set([
  // Object builtins
  "toString", "valueOf", "hasOwnProperty", "constructor",
  // Array mutation
  "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill",
  // Array iteration
  "map", "filter", "reduce", "forEach", "find", "findIndex", "some", "every",
  "includes", "indexOf", "lastIndexOf", "flat", "flatMap", "slice", "concat", "join",
  // String
  "toLowerCase", "toUpperCase", "trim", "split", "replace", "match", "startsWith",
  "endsWith", "includes", "charAt", "substring", "padStart", "padEnd",
  // Set/Map
  "add", "delete", "has", "get", "set", "clear", "keys", "values", "entries",
  // DOM/Events
  "addEventListener", "removeEventListener", "querySelector", "querySelectorAll",
  "getElementById", "getElementsByClassName", "createElement", "appendChild",
  "removeChild", "setAttribute", "getAttribute", "classList", "dispatchEvent",
  "preventDefault", "stopPropagation",
  // Common utility
  "bind", "call", "apply", "then", "catch", "finally", "emit", "on", "off",
  "log", "warn", "error", "info",
])

/**
 * Detect unresolved method references in class-based JS/TS code.
 *
 * When a child agent destructively rewrites a file, it often removes method
 * definitions while keeping calls to those methods in other methods. For example:
 *   - isMoveLegal() calls this.isPawnMove() but isPawnMove was deleted
 *   - makeMove() calls this.handleCastling() but handleCastling was deleted
 *
 * This check extracts all `this.X()` calls and all method/function definitions,
 * then reports calls to methods that don't exist in the file.
 */
function detectUnresolvedMethods(code: string): string[] {
  // Extract all this.X( calls
  const callRe = /this\.([a-zA-Z_$]\w*)\s*\(/g
  const calls = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = callRe.exec(code)) !== null) {
    calls.add(m[1])
  }

  // Extract method definitions: class method syntax, assigned functions, and declarations
  const definitions = new Set<string>()
  // Class method syntax:  methodName(args) { or  async methodName(args) {
  const methodRe = /^\s*(?:async\s+)?([a-zA-Z_$]\w*)\s*\(/gm
  while ((m = methodRe.exec(code)) !== null) {
    if (m[1]) definitions.add(m[1])
  }
  // Also check for get/set accessors: get propertyName() {
  const accessorRe = /^\s*(?:get|set)\s+([a-zA-Z_$]\w*)\s*\(/gm
  while ((m = accessorRe.exec(code)) !== null) {
    if (m[1]) definitions.add(m[1])
  }
  // Also check for function declarations and const assignments
  const funcDeclRe = /function\s+([a-zA-Z_$]\w*)\s*\(/g
  while ((m = funcDeclRe.exec(code)) !== null) {
    if (m[1]) definitions.add(m[1])
  }
  const constFuncRe = /(?:const|let|var)\s+([a-zA-Z_$]\w*)\s*=\s*(?:function|\([^)]*\)\s*=>)/g
  while ((m = constFuncRe.exec(code)) !== null) {
    if (m[1]) definitions.add(m[1])
  }

  // Find unresolved: called via this.X() but never defined, and not a builtin
  const unresolved: string[] = []
  for (const call of calls) {
    if (!definitions.has(call) && !BUILTIN_METHODS.has(call)) {
      unresolved.push(`this.${call}() called but not defined in file`)
    }
  }
  return unresolved.slice(0, 5)  // Cap at 5 to keep output actionable
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

// ============================================================================
// Acceptance criteria keyword extraction
// ============================================================================

/**
 * Common words that should NOT be used as criterion keywords because they
 * appear in almost any codebase and provide no signal.
 */
const CRITERION_STOP_WORDS = new Set([
  // Generic programming terms
  "must", "should", "implement", "function", "method", "code", "logic",
  "data", "value", "values", "return", "check", "that", "this", "with",
  "when", "each", "from", "have", "correctly", "properly", "displayed",
  "support", "allow", "prevent", "include", "system", "state", "valid",
  "invalid", "true", "false", "game", "piece", "pieces", "move", "moves",
  "player", "board", "square", "click", "selected", "display", "area",
  "type", "rule", "rules", "handle", "event", "user", "item", "items",
  "file", "error", "result", "input", "output", "update", "action",
])

/**
 * Extract distinctive keywords from an acceptance criterion.
 *
 * These keywords represent specific features or concepts that should appear
 * somewhere in the code if the criterion is actually implemented.
 *
 * Strategy:
 * - Split on word boundaries, split camelCase
 * - Keep words ≥4 chars that are not stop words
 * - Also detect multi-word technical phrases ("en passant" → "enpassant", "en_passant")
 * - Return lowercase keywords
 *
 * Examples:
 *   "castling must work correctly" → ["castl"]
 *   "pawn promotion to queen" → ["pawn", "promot"]
 *   "check and checkmate detection" → ["checkmate"]  (check is too common)
 *   "en passant capture" → ["passant", "enpassant", "en_passant"]
 */
export function extractCriterionKeywords(criterion: string): string[] {
  const lower = criterion.toLowerCase()
  const keywords: string[] = []

  // Extract multi-word technical phrases first
  const PHRASE_PATTERNS: Array<{ re: RegExp; stems: string[] }> = [
    { re: /en\s+passant/i, stems: ["passant", "enpassant", "en_passant"] },
    { re: /check\s*mate/i, stems: ["checkmate", "check_mate"] },
    { re: /stale\s*mate/i, stems: ["stalemate", "stale_mate"] },
    { re: /drag\s*(?:and|&)\s*drop/i, stems: ["drag", "drop"] },
    { re: /right[\s-]click/i, stems: ["rightclick", "contextmenu"] },
    { re: /double[\s-]click/i, stems: ["dblclick", "doubleclick"] },
    { re: /access[\s-]control/i, stems: ["permission", "authorize", "access"] },
  ]
  for (const { re, stems } of PHRASE_PATTERNS) {
    if (re.test(lower)) {
      keywords.push(...stems)
    }
  }

  // Extract individual words, split camelCase, keep distinctive ones
  const words = lower.split(/[\s,;:.()\[\]{}'"\/\\]+/).filter(w => w.length >= 4)
  for (const word of words) {
    if (CRITERION_STOP_WORDS.has(word)) continue
    // Use word stems (prefix) for matching to handle "castling" matching "castl",
    // "promotion" matching "promot", etc.
    const stem = word.length > 6 ? word.slice(0, Math.max(5, Math.ceil(word.length * 0.7))) : word
    if (stem.length >= 4 && !CRITERION_STOP_WORDS.has(stem)) {
      keywords.push(stem)
    }
  }

  // Deduplicate
  return [...new Set(keywords)]
}

// ============================================================================
// LLM gibberish detection for verifier output
// ============================================================================

/**
 * Detect if a verifier LLM issue string is gibberish/word-salad.
 * The verifier LLM sometimes degenerates and produces nonsense like:
 *   "Edge-action resets fail appropriate bound-scoping interpolated mouse-rerun
 *    initialization layers, creating block scenario loop redundancies"
 * These confuse retry children if injected as retry feedback.
 */
export function isLLMGibberish(issue: string): boolean {
  const words = issue.split(/\s+/).filter(w => w.length > 0)
  if (words.length < 8) return false

  let score = 0

  // Signal 1: Compound-hyphenated jargon: "bound-scoping", "frame-hydro-exclusive"
  const compoundCount = (issue.match(/[a-z]+-[a-z]+-[a-z]+/gi) ?? []).length
  if (compoundCount >= 3) score += 0.4
  else if (compoundCount >= 2) score += 0.2

  // Signal 2: Very few common English function words relative to total
  const functionWords = (issue.match(/\b(the|is|a|an|and|to|of|in|for|with|that|was|it|this|are|not|but|be|has|have|can|does|should|must)\b/gi) ?? []).length
  const ratio = functionWords / words.length
  if (ratio < 0.04 && words.length >= 15) score += 0.4
  else if (ratio < 0.06 && words.length >= 12) score += 0.2

  // Signal 3: No file paths, tool names, or code-relevant indicators
  const hasCodeRefs = /[/\\]|\.(?:js|ts|html|css|py)\b|`[^`]+`|\bfunction\b|\bclass\b|\bconst\b|\bread_file\b|\bwrite_file\b|\breplace_in_file\b|\bstub\b|\bplaceholder\b/i.test(issue)
  if (!hasCodeRefs && words.length >= 10) score += 0.2

  // Signal 4: Very few sentence-ending punctuation relative to word count
  const sentenceEnders = (issue.match(/[.!?]\s/g) ?? []).length + (issue.endsWith(".") || issue.endsWith("!") || issue.endsWith("?") ? 1 : 0)
  if (sentenceEnders === 0 && words.length >= 12) score += 0.1

  return score >= 0.6
}
