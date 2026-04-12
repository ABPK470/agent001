/**
 * Verifier — post-pipeline verification of execution results.
 *
 * Two-phase verification (agenc-core pattern):
 *   1. Deterministic probes — check file existence, run build/test commands
 *   2. LLM-based assessment — structured confidence check per step
 *
 * @module
 */


import { posix as pathPosix } from "node:path"

import { detectPlaceholderPatterns } from "../code-quality.js"
import {
    buildContractSpec,
    getCorrectionGuidance,
    validateDelegatedOutputContract
} from "../delegation-validation.js"
import { normalizeToolExecutionOutput } from "../tool-utils.js"
import type { LLMClient, Message, Tool } from "../types.js"
import {
    type BlueprintSharedTypeSpec,
    normalizeBasename,
    normalizeSpecPath,
    parseBlueprintContractBlock,
    uniqueStrings
} from "./blueprint-contract.js"
import type {
    PipelineResult,
    PipelineStepResult,
    Plan,
    SubagentTaskStep,
    VerificationEvidence,
    VerifierDecision,
    VerifierOutcome,
    VerifierStepAssessment
} from "./types.js"
import { buildSystemChecks, collectVerificationEvidence, deriveIssuesFromEvidence } from "./verification-model.js"

// ============================================================================
// Constants (ported from agenc-core chat-executor-verifier.ts)
// ============================================================================

async function executeToolForText(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return normalizeToolExecutionOutput(await tool.execute(args)).result
}

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
const SHELL_MUTATION_RE =
  /(?:^|[;&|]\s*|\n)\s*(?:cp|mv|rm|mkdir|touch|tee|sed|perl|python|node|ruby|go|cargo|npm|pnpm|yarn|make|cmake|cat|echo|printf)\b|>>?/i
/** Direct mutation tool names. */
const DIRECT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "delete"])

function needsFollowupVerification(assessments: readonly VerifierStepAssessment[]): VerifierStepAssessment[] {
  return assessments.filter((assessment) => {
    if (assessment.confidence < 0.7) return true
    return (assessment.issueDetails ?? []).some((issue) => issue.confidence < 0.7 || issue.ownershipMode !== "deterministic_owner")
  })
}

function collectFollowupEvidence(
  plan: Plan,
  pipelineResult: PipelineResult,
  assessments: readonly VerifierStepAssessment[],
): Map<string, VerificationEvidence[]> {
  const followup = new Map<string, VerificationEvidence[]>()

  for (const assessment of assessments) {
    const step = plan.steps.find((candidate) => candidate.name === assessment.stepName)
    if (step?.stepType !== "subagent_task") continue
    const stepResult = pipelineResult.stepResults.get(assessment.stepName)
    const evidence: VerificationEvidence[] = []
    const reconciliation = stepResult?.reconciliation
    if (reconciliation) {
      reconciliation.findings.forEach((finding, index) => {
        evidence.push({
          id: `${assessment.stepName}:followup:reconciliation:${index + 1}`,
          stepName: assessment.stepName,
          source: "deterministic",
          kind: finding.code,
          message: finding.message,
          artifactPaths: [...finding.artifactPaths],
          details: { severity: finding.severity, phase: "reconciliation" },
        })
      })
    }
    const verificationAttempts = stepResult?.verificationAttempts ?? []
    if (verificationAttempts.length > 0) {
      verificationAttempts.forEach((attempt, index) => {
        if (attempt.success) return
        evidence.push({
          id: `${assessment.stepName}:followup:verification:${index + 1}`,
          stepName: assessment.stepName,
          source: "deterministic",
          kind: "verification_attempt_failure",
          message: `${attempt.toolName}${attempt.target ? `:${attempt.target}` : ""} failed: ${attempt.summary}`,
          artifactPaths: attempt.target ? [attempt.target] : [],
          details: { phase: "followup_verification" },
        })
      })
    }
    if (evidence.length > 0) followup.set(assessment.stepName, evidence)
  }

  return followup
}

function mergeFollowupIntoAssessments(
  plan: Plan,
  assessments: readonly VerifierStepAssessment[],
  followupEvidenceByStep: ReadonlyMap<string, readonly VerificationEvidence[]>,
): VerifierStepAssessment[] {
  const followupSeedAssessments = assessments.map((assessment) => ({
    stepName: assessment.stepName,
    outcome: assessment.outcome,
    confidence: assessment.confidence,
    issues: [...(followupEvidenceByStep.get(assessment.stepName) ?? []).map((evidence) => evidence.message)],
    retryable: assessment.retryable,
  }))
  const followupIssuesByStep = deriveIssuesFromEvidence(plan, followupSeedAssessments, followupEvidenceByStep)

  return assessments.map((assessment) => {
    const followupEvidence = followupEvidenceByStep.get(assessment.stepName) ?? []
    const followupIssues = followupIssuesByStep.get(assessment.stepName) ?? []
    if (followupEvidence.length === 0 && followupIssues.length === 0) return assessment
    return {
      ...assessment,
      confidence: Math.max(assessment.confidence, followupEvidence.length > 0 ? 0.72 : assessment.confidence),
      issues: uniqueStrings([...assessment.issues, ...followupEvidence.map((evidence) => evidence.message)]),
      evidence: uniqueStrings([...(assessment.evidence ?? []).map((evidence) => evidence.id), ...followupEvidence.map((evidence) => evidence.id)])
        .map((id) => ([...(assessment.evidence ?? []), ...followupEvidence].find((evidence) => evidence.id === id)!)),
      issueDetails: [...(assessment.issueDetails ?? []), ...followupIssues],
    }
  })
}

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
  // critical because tool output often says "Successfully wrote to tmp/app/main.js"
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
  // Build candidate paths. When workspaceRoot is absolute, prioritize the
  // workspace-rooted path and avoid probing bare relative paths first, because
  // bare paths can accidentally match host-workspace files with same names.
  const candidates: string[] = []
  const hasAbsoluteWsRoot = Boolean(workspaceRoot && workspaceRoot.startsWith("/"))
  if (workspaceRoot && !plannedPath.startsWith(workspaceRoot)) {
    const rooted = workspaceRoot.endsWith("/")
      ? `${workspaceRoot}${plannedPath}`
      : `${workspaceRoot}/${plannedPath}`
    candidates.push(rooted)
  }
  if (!hasAbsoluteWsRoot || plannedPath.startsWith("/")) {
    candidates.push(plannedPath)
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
      const content = await executeToolForText(readFile, { path: candidate })
      if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
        return { found: true, resolvedPath: candidate }
      }
    } catch { /* fall through */ }

    // Fallback existence probe via shell for cross-root paths that read_file
    // may not be allowed to access directly.
    if (runCommand) {
      try {
        const exists = await executeToolForText(runCommand, {
          command: `if [ -f ${JSON.stringify(candidate)} ]; then echo __FOUND__; else echo __MISSING__; fi`,
        })
        if (/__FOUND__/.test(exists)) {
          return { found: true, resolvedPath: candidate }
        }
      } catch { /* fall through */ }
    }
  }

  // 2. Try to match against paths the child actually wrote
  const basename = plannedPath.split("/").pop() ?? plannedPath
  for (const actual of actualPaths) {
    if (actual === plannedPath || actual.endsWith(`/${plannedPath}`) || actual.endsWith(`/${basename}`)) {
      try {
        const content = await executeToolForText(readFile, { path: actual })
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
      const findResult = await executeToolForText(runCommand, {
        command: `find ${JSON.stringify(searchRoot)} -maxdepth 5 -name ${JSON.stringify(basename)} -type f -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.git/*" 2>/dev/null | head -5`,
      })
      // Accept both absolute and relative paths from find ("./tmp/file.js")
      const foundPaths = findResult.trim().split("\n")
        .filter((p: string) => p.length > 0 && p !== "." && !p.includes("(no output)"))
        .map((p: string) => p.replace(/^\.\//,  ""))
      for (const fp of foundPaths) {
        try {
          const content = await executeToolForText(readFile, { path: fp })
          if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
            return { found: true, resolvedPath: fp }
          }
        } catch { /* fall through */ }
        if (runCommand) {
          try {
            const exists = await executeToolForText(runCommand, {
              command: `if [ -f ${JSON.stringify(fp)} ]; then echo __FOUND__; else echo __MISSING__; fi`,
            })
            if (/__FOUND__/.test(exists)) {
              return { found: true, resolvedPath: fp }
            }
          } catch { /* fall through */ }
        }
      }
    } catch { /* fall through */ }
  }

  // 4. Second-chance find with relative "." as search root — catches cases where
  //    the absolute-path find returns no output due to CWD/sandbox differences.
  if (runCommand && basename) {
    try {
      const findResult2 = await executeToolForText(runCommand, {
        command: `find . -maxdepth 6 -name ${JSON.stringify(basename)} -type f -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -5`,
      })
      const foundPaths2 = findResult2.trim().split("\n")
        .filter((p: string) => p.length > 0 && p !== "." && !p.includes("(no output)"))
        .map((p: string) => p.replace(/^\.\//,  ""))
      for (const fp of foundPaths2) {
        try {
          const content = await executeToolForText(readFile, { path: fp })
          if (!content.startsWith("Error:") && !content.includes("not found") && !content.includes("ENOENT")) {
            return { found: true, resolvedPath: fp }
          }
        } catch { /* fall through */ }
        if (runCommand) {
          try {
            const exists = await executeToolForText(runCommand, {
              command: `if [ -f ${JSON.stringify(fp)} ]; then echo __FOUND__; else echo __MISSING__; fi`,
            })
            if (/__FOUND__/.test(exists)) {
              return { found: true, resolvedPath: fp }
            }
          } catch { /* fall through */ }
        }
      }
    } catch { /* fall through */ }
  }

  return { found: false, resolvedPath: plannedPath }
}

async function readArtifactContent(
  readFile: Tool,
  path: string,
  runCommand?: Tool,
): Promise<string | null> {
  try {
    const content = await executeToolForText(readFile, { path })
    // Treat read_file transport errors as unreadable, but allow legitimate
    // file contents that happen to start with "Error:".
    if (/^Error:\s*(?:ENOENT|ENOTDIR|EISDIR|EACCES|EPERM|Path|Symlink|A parent directory)/i.test(content)) {
      throw new Error(content)
    }
    return content
  } catch {
    if (!runCommand) return null
    try {
      const raw = await executeToolForText(runCommand, {
        command: `if [ -f ${JSON.stringify(path)} ]; then cat ${JSON.stringify(path)}; else echo __MISSING__; fi`,
      })
      if (raw.trim() === "__MISSING__") return null
      return raw
    } catch {
      return null
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeStructuralMarker(kind: string, value: string): string {
  return `${kind}:${value.trim().toLowerCase()}`
}

function collectRegexMarkers(content: string, kind: string, pattern: RegExp, group = 1): string[] {
  const markers: string[] = []
  for (const match of content.matchAll(pattern)) {
    const value = match[group]
    if (typeof value === "string" && value.trim().length > 0) {
      markers.push(normalizeStructuralMarker(kind, value))
    }
  }
  return markers
}

const BLUEPRINT_FILE_PATH_RE = /`([^`]*?(?:index\.[A-Za-z0-9]+|[\w./-]+\.(?:[A-Za-z0-9]{1,8})))`/u
const BLUEPRINT_TREE_FILE_RE = /^[|`'\-+*\\/ ]*([A-Za-z0-9_./-]+\.(?:[A-Za-z0-9]{1,8}))$/u

function extractStructureMarkersFromText(text: string): string[] {
  const markers: string[] = []

  const snippets = [text, ...(Array.from(text.matchAll(/`([^`]+)`/g), match => match[1]))]
  for (const snippet of snippets) {
    for (const match of snippet.matchAll(/<([a-z][a-z0-9-]*)\b/giu)) {
      markers.push(normalizeStructuralMarker("tag", match[1]))
    }
    for (const match of snippet.matchAll(/(^|\s)#([a-z][\w-]*)/giu)) {
      markers.push(normalizeStructuralMarker("id", match[2]))
    }
    for (const match of snippet.matchAll(/(^|\s)\.([a-z][\w-]*)/giu)) {
      markers.push(normalizeStructuralMarker("class", match[2]))
    }
    for (const match of snippet.matchAll(/\b(data-[a-z0-9-]+)\b/giu)) {
      markers.push(normalizeStructuralMarker("data", match[1]))
    }
    for (const match of snippet.matchAll(/\[\s*(data-[a-z0-9-]+)(?:=[^\]]+)?\]/giu)) {
      markers.push(normalizeStructuralMarker("data", match[1]))
    }
    for (const match of snippet.matchAll(/\b([A-Z][A-Za-z0-9]*(?:Panel|View|Component|Layout|Widget|Page|Dialog|Modal|Card|List|Form|Header|Footer|Sidebar|Board|Canvas|Grid))\b/g)) {
      markers.push(normalizeStructuralMarker("component", match[1]))
    }
    for (const match of snippet.matchAll(/\b(?:function|method|proc(?:edure)?|subroutine|def|fn|lambda|handler|command|cmdlet|label|target)\s+`?([A-Za-z_.$@?-][\w.$@-]*)`?/giu)) {
      markers.push(normalizeStructuralMarker("function", match[1]))
    }
    for (const match of snippet.matchAll(/\b(?:class|struct|interface|trait|enum|record|module|namespace|package|type)\s+`?([A-Za-z_.$@?-][\w.$@-]*)`?/giu)) {
      markers.push(normalizeStructuralMarker("type", match[1]))
    }
  }

  return uniqueStrings(markers)
}

function extractHtmlStructureMarkers(content: string): string[] {
  const markers: string[] = []

  for (const match of content.matchAll(/<([a-z][a-z0-9-]*)\b/giu)) {
    markers.push(normalizeStructuralMarker("tag", match[1]))
  }
  for (const match of content.matchAll(/\sid=["']([^"']+)["']/giu)) {
    markers.push(...match[1].split(/\s+/).filter(Boolean).map(value => normalizeStructuralMarker("id", value)))
  }
  for (const match of content.matchAll(/\sclass=["']([^"']+)["']/giu)) {
    markers.push(...match[1].split(/\s+/).filter(Boolean).map(value => normalizeStructuralMarker("class", value)))
  }
  for (const match of content.matchAll(/\s(data-[a-z0-9-]+)(?:=["'][^"']*["'])?/giu)) {
    markers.push(normalizeStructuralMarker("data", match[1]))
  }
  for (const match of content.matchAll(/<script[^>]+src=["']([^"']+)["']/giu)) {
    markers.push(normalizeStructuralMarker("script", normalizeSpecPath(match[1])))
  }
  for (const match of content.matchAll(/<link[^>]+href=["']([^"']+)["']/giu)) {
    markers.push(normalizeStructuralMarker("asset", normalizeSpecPath(match[1])))
  }

  return uniqueStrings(markers)
}

function extractCodeStructureMarkers(content: string): string[] {
  const markers: string[] = []

  markers.push(...collectRegexMarkers(content, "function", /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*def\s+([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*fn\s+([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:public|private|protected|internal|static|final|virtual|override|abstract|sealed|async|partial|inline|constexpr|synchronized|extern|unsafe|new|shared|friend|mut|pub|open|operator|default|class)?(?:\s+(?:public|private|protected|internal|static|final|virtual|override|abstract|sealed|async|partial|inline|constexpr|synchronized|extern|unsafe|new|shared|friend|mut|pub|open|operator|default))*\s*[A-Za-z_][\w<>,.?\[\]]*\s+([A-Za-z_][\w]*)\s*\([^;\n{}]*\)\s*(?:\{|=>)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\b/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\s*\{/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\b/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*sub\s+([A-Za-z_][\w]*)\b/gi))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*proc(?:edure)?\s+([A-Za-z_][\w]*)\b/gi))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*\.?(?:globl|global)\s+([A-Za-z_.$@?][\w.$@?]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*([A-Za-z_.$@?][\w.$@?]*)\s*:/g))
  markers.push(...collectRegexMarkers(content, "function", /\(defun\s+([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /\(defmacro\s+([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /\(define\s+\(([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:function|filter|workflow)\s+([A-Za-z_][\w-]*)\b/gi))

  markers.push(...collectRegexMarkers(content, "type", /export\s+class\s+([A-Za-z_$][\w$]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*(?:class|struct|interface|trait|enum|record|module|namespace|package)\s+([A-Za-z_][\w.]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*(?:public|private|protected|internal)?\s*(?:abstract\s+|final\s+|sealed\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface|=)/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*New-Alias\s+-Name\s+([A-Za-z_][\w-]*)\b/gi))

  markers.push(...collectRegexMarkers(content, "component", /(?:^|\n)\s*const\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*\([^)]*\)\s*=>\s*</g))
  markers.push(...collectRegexMarkers(content, "component", /(?:^|\n)\s*function\s+([A-Z][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{?[\s\S]{0,120}?return\s*\(/g))
  markers.push(...collectRegexMarkers(content, "component", /<([A-Z][A-Za-z0-9_]*)\b/g))
  markers.push(...collectRegexMarkers(content, "tag", /<([a-z][a-z0-9-]*)\b/g))

  return uniqueStrings(markers)
}

function detectStructuralMarkersInArtifact(path: string, content: string): string[] {
  if (/\.html?$/i.test(path)) return extractHtmlStructureMarkers(content)
  if (/\.(?:tsx|jsx)$/i.test(path)) return uniqueStrings([...extractHtmlStructureMarkers(content), ...extractCodeStructureMarkers(content)])
  if (/\.(?:ts|js|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|cs|vb|php|rb|swift|scala|sh|bash|zsh|fish|ps1|psm1|psd1|pl|pm|lua|r|jl|clj|cljs|cljc|lisp|el|asm|s|S|c|cc|cpp|cxx|h|hpp|hh)$/i.test(path)) return extractCodeStructureMarkers(content)
  if (/\.(?:xml|xaml|csproj|fsproj|vbproj|gradle|properties|toml|yaml|yml|json|ini|cfg|conf|sql|md|txt)$/i.test(path)) return uniqueStrings([...extractStructureMarkersFromText(content), ...extractCodeStructureMarkers(content)])
  return []
}

function collectSpecAuditIssues(
  step: SubagentTaskStep,
  stepResult: PipelineStepResult,
  blueprintPath: string,
): string[] {
  const calls = stepResult.toolCalls ?? []
  const normalizedBlueprint = normalizeSpecPath(blueprintPath)
  const issues: string[] = []
  const blueprintIsTargetArtifact = step.executionContext.targetArtifacts
    .map(normalizeSpecPath)
    .includes(normalizedBlueprint)

  const firstBlueprintReadIndex = calls.findIndex(call => {
    if (call.name !== "read_file") return false
    const path = typeof call.args.path === "string" ? normalizeSpecPath(call.args.path) : ""
    return path === normalizedBlueprint || /(?:^|\/)BLUEPRINT\.md$/i.test(path)
  })

  if (firstBlueprintReadIndex === -1) {
    if (!blueprintIsTargetArtifact) {
      issues.push(`PROCESS AUDIT FAILED: step ${step.name} never read ${blueprintPath}`)
    }
    return issues
  }

  const firstMutationIndex = calls.findIndex(call => {
    if (DIRECT_MUTATION_TOOLS.has(call.name)) return true
    if (call.name !== "run_command") return false
    const command = typeof call.args.command === "string" ? call.args.command : ""
    return SHELL_MUTATION_RE.test(command)
  })

  if (firstMutationIndex !== -1 && firstBlueprintReadIndex > firstMutationIndex && !blueprintIsTargetArtifact) {
    issues.push(
      `PROCESS AUDIT FAILED: step ${step.name} read ${blueprintPath} only after starting file mutations`,
    )
  }

  const targetReads = new Set(
    calls.flatMap(call => {
      if (call.name !== "read_file") return []
      const path = typeof call.args.path === "string" ? normalizeSpecPath(call.args.path) : ""
      return path ? [path] : []
    }),
  )
  const replaceInFileTargets = new Set(
    calls.flatMap(call => {
      if (call.name !== "replace_in_file") return []
      const path = typeof call.args.path === "string" ? normalizeSpecPath(call.args.path) : ""
      return path ? [path] : []
    }),
  )
  const readRequiredTargets = new Set(step.executionContext.requiredSourceArtifacts.map(normalizeSpecPath))
  const missingTargetReads = step.executionContext.targetArtifacts
    .map(normalizeSpecPath)
    .filter(path => readRequiredTargets.has(path) || replaceInFileTargets.has(path))
    .filter(path => !targetReads.has(path))

  if (missingTargetReads.length > 0) {
    issues.push(
      `PROCESS AUDIT WEAK: step ${step.name} mutated or produced artifacts without reading target files first (${missingTargetReads.slice(0, 4).join(", ")})`,
    )
  }

  return issues
}

function parseBlueprintSpec(blueprintPath: string, content: string): BlueprintSpec {
  const fileMap = new Map<string, BlueprintFileSpec>()
  const contractBlock = parseBlueprintContractBlock(content)
  const sharedTypes = new Set<string>(contractBlock.sharedTypes.map((type) => type.name))
  const algorithmicContracts = new Set<string>()
  let currentFile: string | null = null
  let inSharedTypes = false
  let inAlgorithmSection = false

  const ensureFile = (declaredPath: string): BlueprintFileSpec => {
    const normalizedPath = normalizeSpecPath(declaredPath)
    const existing = fileMap.get(normalizedPath)
    if (existing) return existing
    const created: BlueprintFileSpec = {
      declaredPath: normalizedPath,
      basename: normalizeBasename(normalizedPath),
      functions: [],
      structuralMarkers: [],
    }
    fileMap.set(normalizedPath, created)
    return created
  }

  const appendFunction = (declaredPath: string, spec: BlueprintFunctionSpec) => {
    const normalizedPath = normalizeSpecPath(declaredPath)
    const existing = ensureFile(normalizedPath)
    if (existing.functions.some(fn => fn.name === spec.name)) return
    fileMap.set(normalizedPath, {
      ...existing,
      functions: [...existing.functions, spec],
    })
  }

  const appendStructuralMarkers = (declaredPath: string, markers: readonly string[]) => {
    const normalizedPath = normalizeSpecPath(declaredPath)
    const existing = ensureFile(normalizedPath)
    fileMap.set(normalizedPath, {
      ...existing,
      structuralMarkers: uniqueStrings([...existing.structuralMarkers, ...markers]),
    })
  }

  for (const contractFile of contractBlock.files) {
    ensureFile(contractFile.declaredPath)
    if (contractFile.functions.length > 0) {
      for (const spec of contractFile.functions) appendFunction(contractFile.declaredPath, spec)
    }
    if (contractFile.structuralMarkers.length > 0) {
      appendStructuralMarkers(contractFile.declaredPath, contractFile.structuralMarkers)
    }
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (/^#{1,6}\s+/u.test(line)) {
      const heading = line.replace(/^#{1,6}\s+/u, "").trim().toLowerCase()
      inSharedTypes = heading.includes("shared data") || heading.includes("data structures")
      inAlgorithmSection = heading.includes("algorithm") || heading.includes("logic") || heading.includes("flow")
      currentFile = null
    }

    const inlineFileMatch = line.match(BLUEPRINT_FILE_PATH_RE)
    if (inlineFileMatch) {
      currentFile = normalizeSpecPath(inlineFileMatch[1])
      ensureFile(currentFile)
    }

    const treeMatch = line.match(BLUEPRINT_TREE_FILE_RE)
    if (treeMatch) {
      currentFile = normalizeSpecPath(treeMatch[1])
      ensureFile(currentFile)
    }

    if (currentFile) {
      const markers = extractStructureMarkersFromText(line)
      if (markers.length > 0) appendStructuralMarkers(currentFile, markers)
    }

    const functionMatch = line.match(/^(?:[-*]\s*|\d+\.\s*)(?:(?:function|method|proc(?:edure)?|subroutine|handler|command|cmdlet|def|fn|lambda|label|target)\s+)?`?([A-Za-z_.$@?-][\w.$@?-]*)\s*\(([^)]*)\)`?(?::|\s|$)/iu)
    if (functionMatch && currentFile) {
      appendFunction(currentFile, {
        name: functionMatch[1],
        signature: `${functionMatch[1]}(${functionMatch[2].trim()})`,
      })
    }

    const sharedTypeMatch = line.match(/`([A-Z][A-Za-z0-9_]+)`/u)
    if (sharedTypeMatch && inSharedTypes) {
      sharedTypes.add(sharedTypeMatch[1])
    }

    if (inAlgorithmSection && /^[-*]\s+/u.test(line)) {
      algorithmicContracts.add(line.replace(/^[-*]\s+/u, "").trim())
    }
  }

  return {
    blueprintPath,
    files: Array.from(fileMap.values()),
    contractFiles: contractBlock.files,
    contractSharedTypes: contractBlock.sharedTypes,
    contractBlockPresent: contractBlock.present,
    contractBlockErrors: Array.from(contractBlock.errors),
    sharedTypes: Array.from(sharedTypes),
    algorithmicContracts: Array.from(algorithmicContracts),
  }
}

function collectSourceReadEvidence(stepResult: PipelineStepResult, blueprintPath: string): string[] {
  const reads = (stepResult.toolCalls ?? [])
    .filter(call => call.name === "read_file" || call.name === "search_files")
    .map(call => {
      const pathArg = typeof call.args.path === "string"
        ? call.args.path
        : typeof call.args.pattern === "string"
          ? call.args.pattern
          : null
      return pathArg ? normalizeSpecPath(pathArg) : null
    })
    .filter((value): value is string => Boolean(value))

  const normalizedBlueprint = normalizeSpecPath(blueprintPath)
  return uniqueStrings(reads.filter(read => read.includes("BLUEPRINT.md") || read === normalizedBlueprint))
}

function findBlueprintForStep(step: SubagentTaskStep): string | null {
  return step.executionContext.requiredSourceArtifacts.find(
    (artifact: string) => /(^|\/)BLUEPRINT\.md$/iu.test(artifact),
  )
    ?? step.executionContext.targetArtifacts.find(
      (artifact: string) => /(^|\/)BLUEPRINT\.md$/iu.test(artifact),
    )
    ?? null
}

function detectFunctionsInArtifact(
  content: string,
  functions: readonly BlueprintFunctionSpec[],
): { found: string[]; missing: string[] } {
  const found: string[] = []
  const missing: string[] = []

  for (const spec of functions) {
    const pattern = new RegExp(`\\b${escapeRegExp(spec.name)}\\s*\\(`, "u")
    if (pattern.test(content)) found.push(spec.name)
    else missing.push(spec.name)
  }

  return { found, missing }
}

function isCodeLikeBlueprintArtifact(path: string): boolean {
  return /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|cs|php|rb|swift|scala|sh|bash|zsh|ps1)$/i.test(path)
}

function isWeakFunctionContract(spec: BlueprintFunctionSpec): boolean {
  const signature = spec.signature.trim()
  if (!signature) return true
  if (signature === `${spec.name}()`) return true
  if (/\b(?:todo|tbd|placeholder)\b|\.\.\./i.test(signature)) return true
  return false
}

function buildBlueprintFunctionContractIssues(
  step: SubagentTaskStep,
  spec: BlueprintSpec,
  blueprintPath: string,
): string[] {
  if (!isBlueprintLikeStepForVerifier(step)) return []

  const issues: string[] = []
  const mergedFiles = new Map(spec.files.map((file) => [normalizeSpecPath(file.declaredPath), file]))

  for (const contractFile of spec.contractFiles) {
    const normalizedPath = normalizeSpecPath(contractFile.declaredPath)
    const merged = mergedFiles.get(normalizedPath)
    const contractNames = new Set(contractFile.functions.map((fn) => fn.name))
    const proseOnlyFunctions = (merged?.functions ?? []).filter((fn) => !contractNames.has(fn.name))
    const weakFunctions = contractFile.functions.filter((fn) => isWeakFunctionContract(fn))

    if (proseOnlyFunctions.length > 0) {
      issues.push(
        `BLUEPRINT FUNCTION CONTRACT DRIFT: machine contract for ${contractFile.declaredPath} omits functions declared elsewhere in ${blueprintPath} (${proseOnlyFunctions.map((fn) => fn.name).join(", ")})`,
      )
    }

    if (weakFunctions.length > 0 && isCodeLikeBlueprintArtifact(contractFile.declaredPath)) {
      issues.push(
        `BLUEPRINT FUNCTION CONTRACT WEAK: ${contractFile.declaredPath} contains underspecified machine contract signatures (${weakFunctions.map((fn) => fn.signature).join(", ")})`,
      )
    }
  }

  return issues
}

function buildBlueprintSharedTypeContractIssues(
  step: SubagentTaskStep,
  spec: BlueprintSpec,
  plan: Plan,
  blueprintPath: string,
): string[] {
  if (!isBlueprintLikeStepForVerifier(step)) return []

  const issues: string[] = []
  const plannedArtifacts = new Set(collectPlannedBlueprintArtifacts(plan))
  const declaredArtifacts = new Set(
    spec.contractFiles
      .map((file) => normalizeSpecPath(file.declaredPath))
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact)),
  )
  const contractTypeNames = new Set(spec.contractSharedTypes.map((type) => type.name))
  const proseOnlyTypes = spec.sharedTypes.filter((type) => !contractTypeNames.has(type))

  if (proseOnlyTypes.length > 0) {
    issues.push(
      `BLUEPRINT SHARED TYPE DRIFT: ${blueprintPath} describes shared types outside the machine contract (${proseOnlyTypes.join(", ")})`,
    )
  }

  const weakSharedTypes = spec.contractSharedTypes.filter((type) => !type.definition.trim())
  if (weakSharedTypes.length > 0) {
    issues.push(
      `BLUEPRINT SHARED TYPE CONTRACT WEAK: sharedTypes entries must include a concrete definition (${weakSharedTypes.map((type) => type.name).join(", ")})`,
    )
  }

  const driftedUsage = spec.contractSharedTypes.filter((type) => type.usedBy.length > 0 &&
    type.usedBy.some((path) => {
      const normalized = normalizeSpecPath(path)
      return !declaredArtifacts.has(normalized) && !plannedArtifacts.has(normalized)
    }),
  )
  if (driftedUsage.length > 0) {
    issues.push(
      `BLUEPRINT SHARED TYPE DRIFT: sharedTypes.usedBy references undeclared artifacts (${driftedUsage.map((type) => type.name).join(", ")})`,
    )
  }

  const sharedTypeRequired = /\bshared\s+(?:data|types?|state|schema|model|structure|contract)\b/i.test(
    [step.objective, ...step.acceptanceCriteria].join(" "),
  )
  if (sharedTypeRequired && spec.contractSharedTypes.length === 0) {
    issues.push(
      `BLUEPRINT SHARED TYPE CONTRACT WEAK: ${blueprintPath} declares no sharedTypes even though the blueprint contract requires shared data coordination`,
    )
  }

  return issues
}

async function buildStepSpecEvidence(
  step: SubagentTaskStep,
  stepResult: PipelineStepResult,
  plan: Plan,
  readFile: Tool,
  runCommand?: Tool,
  actualPaths: string[] = [],
): Promise<StepSpecEvidence | null> {
  const blueprintPath = findBlueprintForStep(step)
  if (!blueprintPath) return null

  const blueprintContent = await readArtifactContent(readFile, blueprintPath, runCommand)
  if (!blueprintContent) {
    return {
      stepName: step.name,
      blueprintPath,
      sourceReads: collectSourceReadEvidence(stepResult, blueprintPath),
      mappings: [],
      contractSharedTypes: [],
      sharedTypes: [],
      algorithmicContracts: [],
      structuralIssues: [`SPEC INGESTION FAILED: could not read ${blueprintPath} for step ${step.name}`],
      processAuditIssues: collectSpecAuditIssues(step, stepResult, blueprintPath),
    }
  }

  const spec = parseBlueprintSpec(blueprintPath, blueprintContent)
  const structuralIssues: string[] = []
  const mappings: ArtifactSpecMapping[] = []
  const sourceReads = collectSourceReadEvidence(stepResult, blueprintPath)
  const processAuditIssues = collectSpecAuditIssues(step, stepResult, blueprintPath)

  if (sourceReads.length === 0) {
    structuralIssues.push(
      `SPEC EVIDENCE MISSING: step ${step.name} did not read ${blueprintPath} before producing artifacts`,
    )
  }

  if (spec.files.length === 0) {
    structuralIssues.push(
      `SPEC INGESTION WEAK: ${blueprintPath} did not yield any declared file structure for step ${step.name}`,
    )
  }

  structuralIssues.push(...buildBlueprintArtifactCoverageIssues(step, spec, plan, blueprintPath))
  structuralIssues.push(...buildBlueprintFunctionContractIssues(step, spec, blueprintPath))
  structuralIssues.push(...buildBlueprintSharedTypeContractIssues(step, spec, plan, blueprintPath))

  for (const artifact of step.executionContext.targetArtifacts) {
    const normalizedArtifact = normalizeSpecPath(artifact)
    if (isBlueprintLikeStepForVerifier(step) && normalizedArtifact === normalizeSpecPath(blueprintPath)) {
      continue
    }
    const exactMatch = spec.files.find(file => normalizeSpecPath(file.declaredPath) === normalizedArtifact)
    const basenameMatch = exactMatch
      ? null
      : spec.files.find(file => file.basename === normalizeBasename(normalizedArtifact))
    const matchedSpec = exactMatch ?? basenameMatch ?? null
    const probe = await probeArtifact(
      readFile,
      artifact,
      actualPaths,
      step.executionContext.workspaceRoot || undefined,
      runCommand,
      step.executionContext.allowedWriteRoots,
    )
    const resolvedArtifactPath = probe.found ? probe.resolvedPath : null
    const content = resolvedArtifactPath
      ? await readArtifactContent(readFile, resolvedArtifactPath, runCommand)
      : null
    const functionEvidence = matchedSpec && content
      ? detectFunctionsInArtifact(content, matchedSpec.functions)
      : { found: [], missing: matchedSpec?.functions.map(fn => fn.name) ?? [] }
    const actualStructuralMarkers = content ? detectStructuralMarkersInArtifact(artifact, content) : []
    const requiredStructuralMarkers = matchedSpec?.structuralMarkers ?? []
    const foundStructuralMarkers = requiredStructuralMarkers.filter(marker => actualStructuralMarkers.includes(marker))
    const missingStructuralMarkers = requiredStructuralMarkers.filter(marker => !actualStructuralMarkers.includes(marker))

    mappings.push({
      targetArtifact: artifact,
      actualArtifactPath: resolvedArtifactPath,
      matchedSpecPath: matchedSpec?.declaredPath ?? null,
      pathMatch: exactMatch ? "exact" : basenameMatch ? "basename" : "none",
      foundFunctions: functionEvidence.found,
      missingFunctions: functionEvidence.missing,
      foundStructuralMarkers,
      missingStructuralMarkers,
    })

    if (!matchedSpec) {
      structuralIssues.push(
        `SPEC MAPPING MISSING: target artifact ${artifact} does not map to any file declared in ${blueprintPath}`,
      )
      continue
    }

    if (!exactMatch && basenameMatch) {
      structuralIssues.push(
        `SPEC PATH MISMATCH: target artifact ${artifact} only matches blueprint file ${matchedSpec.declaredPath} by basename`,
      )
    }

    if (content && functionEvidence.missing.length > 0) {
      structuralIssues.push(
        `SPEC FUNCTION MISMATCH: ${artifact} is missing blueprint functions ${functionEvidence.missing.join(", ")} from ${matchedSpec.declaredPath}`,
      )
    }

    if (content && missingStructuralMarkers.length > 0) {
      structuralIssues.push(
        `SPEC STRUCTURE MISMATCH: ${artifact} is missing blueprint structure markers ${missingStructuralMarkers.join(", ")} from ${matchedSpec.declaredPath}`,
      )
    }
  }

  return {
    stepName: step.name,
    blueprintPath,
    sourceReads,
    mappings,
    contractSharedTypes: spec.contractSharedTypes,
    sharedTypes: spec.sharedTypes,
    algorithmicContracts: spec.algorithmicContracts,
    structuralIssues,
    processAuditIssues,
  }
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
      const executedModalities = new Set<string>()

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
          } else {
            // probeArtifact performs a deterministic read check; count it as
            // artifact review coverage for modality checks.
            executedModalities.add("artifact-review")
          }
        }
      }

      if (readFile) {
        const specEvidence = await buildStepSpecEvidence(sa, stepResult, plan, readFile, runCommand, actualPaths)
        if (specEvidence) {
          issues.push(...specEvidence.structuralIssues)
          issues.push(...specEvidence.processAuditIssues)
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
      const allowedIntegrationWriteSet = new Set(
        sa.executionContext.requiredSourceArtifacts.map(a => a.replace(/^\.\//, "")),
      )
      // For scope violation checking, use ONLY write-action patterns — not backtick
      // mentions. A blueprint step's output text naturally contains backtick-quoted
      // paths like `tmp/game.js` when describing planned artifacts, but those files
      // were NOT actually written. Using the broad extractActualPaths (which catches
      // backtick-quoted names) produces false-positive SCOPE VIOLATIONs for blueprint
      // steps that merely mention other steps' files in their documentation.
      const writtenPathsForScopeCheck = new Set<string>()
      for (const m of outputText.matchAll(/(?:creat|writ|wrote|modif|generat|saved)\w*\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
        if (m[1] && m[1].length < 200) writtenPathsForScopeCheck.add(m[1])
      }
      for (const actual of writtenPathsForScopeCheck) {
        const normActual = actual.replace(/^\.\//, "")
        // Strip workspace root prefix for comparison
        const stripped = wsRoot
          ? normActual.replace(new RegExp(`^${wsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "")
          : normActual
        if (allowedIntegrationWriteSet.has(stripped) || allowedIntegrationWriteSet.has(normActual)) {
          // Integration wiring edits are allowed only when the artifact was
          // explicitly declared as required source context for this step.
          continue
        }
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

      // Runtime probe: for HTML artifacts, run browser_check regardless of
      // verificationMode to ensure UI/runtime behavior gets deterministic checks.
      let browserCheckPassed = false
      const htmlArtifacts = sa.executionContext.targetArtifacts.filter(
        a => a.endsWith(".html") || a.endsWith(".htm"),
      )
      if (htmlArtifacts.length > 0) {
        const browserCheck = toolMap.get("browser_check")
        if (browserCheck) {
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
              executedModalities.add("runtime")
              const result = await executeToolForText(browserCheck, { path: browserPath })
              if (/error|fail|exception/i.test(result) && !/no errors/i.test(result)) {
                // ERR_CONNECTION_REFUSED / Failed to fetch to localhost means a backend API
                // server is not running during static verification.  This is expected for
                // frontend+backend projects.  Also treat 404s on localhost/127.0.0.1 the
                // same way: when the LLM generates an Express app that serves both static
                // files AND API routes, browser_check's standalone static server will 404
                // on any relative API call (e.g. /api/data) — the backend is simply not
                // running, not a code bug.
                const isBackendNotRunningLine = (ln: string): boolean =>
                  /ERR_CONNECTION_REFUSED|net::ERR_CONNECTION|Failed to fetch/i.test(ln) ||
                  // 404 on a localhost/127.0.0.1 URL → backend API endpoint, not running
                  (/(404|Not Found)/i.test(ln) && /(localhost|127\.0\.0\.1)[:/]/i.test(ln))
                const allErrorsAreBackendNotRunning = result
                  .split("\n")
                  .filter(ln => /error|fail|exception/i.test(ln))
                  .every(ln => isBackendNotRunningLine(ln))
                if (!allErrorsAreBackendNotRunning) {
                  issues.push(`Browser check for "${browserPath}" reported errors: ${result.slice(0, 300)}`)
                  anyBrowserFailure = true
                }
              }
            } catch {
              issues.push(`Browser check failed for "${browserPath}"`)
              anyBrowserFailure = true
            }
          }
          if (!anyBrowserFailure) {
            browserCheckPassed = true
          }
        } else {
          issues.push("VERIFICATION MODALITY GAP: HTML artifacts exist but browser_check tool is unavailable, so runtime verification could not run")
        }
      }

      // If verification mode is run_tests, run the test command
      if (sa.executionContext.verificationMode === "run_tests") {
        const runCmd = toolMap.get("run_command")
        if (runCmd) {
          try {
            executedModalities.add("runtime")
            const result = await executeToolForText(runCmd, { command: "npm test 2>&1 || exit 0" })
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
            const content = await readArtifactContent(readFile, cached.resolvedPath, runCommand)
            if (typeof content === "string" && content.length > 0) {
              executedModalities.add("artifact-review")
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
              const unresolvedHelpers = detectUnresolvedBareHelpers(content)
              if (unresolvedHelpers.length > 0) {
                issues.push(
                  `Missing helper dependency/dependencies in "${artifact}": ${unresolvedHelpers.join("; ")}`,
                )
              }
              const useBeforeDeclaration = detectPotentialUseBeforeDeclaration(content)
              if (useBeforeDeclaration.length > 0) {
                issues.push(
                  `Potential temporal-dead-zone/use-before-declaration issue in "${artifact}": ${useBeforeDeclaration.join("; ")}`,
                )
              }
            }
          } catch { /* already flagged */ }
        }

        const styleArtifacts = sa.executionContext.targetArtifacts.filter(
          a => /\.(?:css|scss|sass|less)$/i.test(a),
        )
        for (const artifact of styleArtifacts) {
          const cached = probeCache.get(artifact)
          if (!cached?.found) continue
          try {
            const content = await readArtifactContent(readFile, cached.resolvedPath, runCommand)
            if (typeof content === "string" && content.length > 0) {
              executedModalities.add("artifact-review")
              const stripingIssues = detectPotentialLinearGridStriping(content)
              if (stripingIssues.length > 0) {
                issues.push(
                  `Potential 2D grid styling bug in "${artifact}": ${stripingIssues.join("; ")}`,
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
              const result = await executeToolForText(runCommand, {
                command: `node --check ${JSON.stringify(checkPath)} 2>&1`,
              })
              executedModalities.add("syntax")
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
              const content = await readArtifactContent(readFile, cached.resolvedPath, runCommand)
            if (typeof content === "string" && content.length > 0) {
              executedModalities.add("artifact-review")
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
            const content = await readArtifactContent(readFile, cached.resolvedPath, runCommand)
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

      // Runtime-facing criteria require runtime proof, not only static code checks.
      const runtimeCriterionRe = /\b(?:click|submit|drag|drop|keyboard|mouse|interactive|render|display|preview|execute|run|workflow|integration|e2e|end[- ]to[- ]end|api|request|response|endpoint|fetch|http|query|database|sql|persist|sync|auth|login)\b/i
      const complexRuleCriterionRe = /\b(?:all rules|special moves|castling|en passant|promotion|checkmate|stalemate|king safety|piece[- ]specific|illegal move|turn[- ]based|full game logic|complete logic|algorithmic contract)\b/i
      const docsOnlyArtifacts = sa.executionContext.targetArtifacts.length > 0 &&
        sa.executionContext.targetArtifacts.every((artifact) => /\.(?:md|markdown|txt|rst|adoc)$/i.test(artifact))
      if (!docsOnlyArtifacts && !executedModalities.has("runtime")) {
        const runtimeCriteria = sa.acceptanceCriteria.filter(c => runtimeCriterionRe.test(c))
        if (runtimeCriteria.length > 0) {
          issues.push(
            `CRITERIA PROOF MISSING: runtime criteria were declared but no runtime probe executed (${runtimeCriteria.length}/${sa.acceptanceCriteria.length})`,
          )
        }
      }

      const role = sa.executionContext.role ?? "writer"
      if (role !== "writer") {
        const complexCriteria = sa.acceptanceCriteria.filter(c => complexRuleCriterionRe.test(c))
        const blanketComplexClaim = /\b(?:all|fully|complete(?:ly)?|properly)\b.{0,80}\b(?:rules|logic|workflow|constraints|requirements)\b/i.test(outputText)
        const runtimeOnlyEvidence = executedModalities.has("runtime") && !executedModalities.has("tests")
        if (complexCriteria.length > 0 && runtimeOnlyEvidence && blanketComplexClaim) {
          issues.push(
            `CRITERIA PROOF MISSING: validator/reviewer claimed complex rule coverage from broad runtime evidence only (${complexCriteria.length} complex criteria). Require criterion-by-criterion evidence from code review or executable tests, not just a successful browser/render pass.`,
          )
        }
      }

      // ── General verification modality coverage probe ──
      const modalityGaps = detectVerificationModalityGaps(sa, executedModalities, toolMap)
      issues.push(...modalityGaps)

      // ── Gibberish / word-salad detection ──
      if (outputText.length > 20) {
        const gibberishScore = computeGibberishScore(outputText)
        if (gibberishScore >= 0.6) {
          issues.push("Child output appears to be gibberish/word-salad — no coherent implementation summary")
        }
      }

      // ── Role-specific validation (agenc-core pattern) ──
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

      // Shared-state contract enforcement: one owner mutates; consumers must read owner artifact.
      const shared = sa.executionContext.sharedStateContract
      if (shared) {
        if (sa.name !== shared.ownerStepName) {
          const required = new Set(sa.executionContext.requiredSourceArtifacts.map(a => a.replace(/^\.\//, "")))
          const ownerArtifact = shared.ownerArtifactPath.replace(/^\.\//, "")
          if (!required.has(ownerArtifact)) {
            issues.push(
              `CRITERIA PROOF MISSING: shared-state contract requires consuming owner artifact "${shared.ownerArtifactPath}", but it is missing from requiredSourceArtifacts`,
            )
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
        "degeneration", "PATH MISMATCH", "SCOPE VIOLATION",
        "VERIFICATION MODALITY GAP", "CRITERIA PROOF MISSING",
        "SPEC ", "PROCESS AUDIT", "BLUEPRINT ARTIFACT",
        "BLUEPRINT FUNCTION CONTRACT", "BLUEPRINT SHARED TYPE",
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

      const hasBlockingCriteriaProofGap = issues.some(isBlockingCriteriaProofGap)
      const confidence = Math.max(0, 1 - Math.min(0.9, effectiveIssueCount * 0.18))
      const outcome: VerifierOutcome = hasBlockingCriteriaProofGap
        ? "fail"
        : effectiveIssueCount > 0
          ? (confidence < DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE ? "fail" : "retry")
          : "pass"

      assessments.push({
        stepName: step.name,
        outcome,
        confidence,
        issues: effectiveIssueCount < issues.length
          ? [...structuralIssues, ...nonStructuralIssues.map(i => `[non-blocking] ${i}`)]
          : issues,
        retryable: !hasBlockingCriteriaProofGap,
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
  // Run ONLY after all subagent steps completed; otherwise this creates
  // premature failures while artifacts are still being assembled.
  const allSubagentStepsCompleted = plan.steps
    .filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")
    .every((s) => pipelineResult.stepResults.get(s.name)?.status === "completed")

  if (allSubagentStepsCompleted) {
    await runIntegrationProbes(plan, pipelineResult, toolMap, assessments)
  }

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
  const allArtifacts = collectIntegrationArtifacts(plan)
  const ctx: IntegrationProbeContext = {
    plan,
    toolMap,
    assessments,
    allArtifacts,
  }

  const probes: readonly IntegrationProbe[] = [
    probeWebEntrypointRuntimeWiring,
    probeBrowserModuleCompatibility,
    probeCssClassContracts,
    probeLocalModuleImportBindings,
    probeCrossFileFunctionSignatures,
  ]
  for (const probe of probes) {
    await probe(ctx)
  }
}

interface IntegrationArtifact {
  path: string
  stepName: string
}

interface IntegrationProbeContext {
  plan: Plan
  toolMap: Map<string, Tool>
  assessments: VerifierStepAssessment[]
  allArtifacts: readonly IntegrationArtifact[]
}

interface ModuleImportRef {
  readonly specifier: string
  readonly importedNames: readonly string[]
  readonly defaultImport?: string
  readonly namespaceImport?: string
}

interface BlueprintFunctionSpec {
  readonly name: string
  readonly signature: string
}

interface BlueprintFileSpec {
  readonly declaredPath: string
  readonly basename: string
  readonly functions: readonly BlueprintFunctionSpec[]
  readonly structuralMarkers: readonly string[]
}

interface BlueprintSpec {
  readonly blueprintPath: string
  readonly files: readonly BlueprintFileSpec[]
  readonly contractFiles: readonly BlueprintFileSpec[]
  readonly contractSharedTypes: readonly BlueprintSharedTypeSpec[]
  readonly contractBlockPresent: boolean
  readonly contractBlockErrors: readonly string[]
  readonly sharedTypes: readonly string[]
  readonly algorithmicContracts: readonly string[]
}

interface ArtifactSpecMapping {
  readonly targetArtifact: string
  readonly actualArtifactPath: string | null
  readonly matchedSpecPath: string | null
  readonly pathMatch: "exact" | "basename" | "none"
  readonly foundFunctions: readonly string[]
  readonly missingFunctions: readonly string[]
  readonly foundStructuralMarkers: readonly string[]
  readonly missingStructuralMarkers: readonly string[]
}

interface StepSpecEvidence {
  readonly stepName: string
  readonly blueprintPath: string
  readonly sourceReads: readonly string[]
  readonly mappings: readonly ArtifactSpecMapping[]
  readonly contractSharedTypes: readonly BlueprintSharedTypeSpec[]
  readonly sharedTypes: readonly string[]
  readonly algorithmicContracts: readonly string[]
  readonly structuralIssues: readonly string[]
  readonly processAuditIssues: readonly string[]
}

function isBlueprintLikeStepForVerifier(step: SubagentTaskStep): boolean {
  return /blueprint/i.test(step.name)
    || step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
}

function collectPlannedBlueprintArtifacts(plan: Plan): string[] {
  return uniqueStrings(
    plan.steps
      .filter((step): step is SubagentTaskStep => step.stepType === "subagent_task")
      .filter((step) => !isBlueprintLikeStepForVerifier(step))
      .flatMap((step) => step.executionContext.targetArtifacts)
      .map(normalizeSpecPath)
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact)),
  )
}

function buildBlueprintArtifactCoverageIssues(
  step: SubagentTaskStep,
  spec: BlueprintSpec,
  plan: Plan,
  blueprintPath: string,
): string[] {
  if (!isBlueprintLikeStepForVerifier(step)) return []
  if (!spec.contractBlockPresent) {
    return [
      `BLUEPRINT CONTRACT MISSING: ${blueprintPath} must include a machine-readable \`blueprint-contract\` JSON block with the exact planned artifact paths before implementation steps can run`,
    ]
  }
  if (spec.contractBlockErrors.length > 0) return [...spec.contractBlockErrors]

  const declaredArtifacts = uniqueStrings(
    spec.contractFiles
      .map((file) => normalizeSpecPath(file.declaredPath))
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact)),
  )
  const plannedArtifacts = collectPlannedBlueprintArtifacts(plan)
  const missingPlanned = plannedArtifacts.filter((artifact) => !declaredArtifacts.includes(artifact))
  const undeclaredExtras = declaredArtifacts.filter((artifact) => !plannedArtifacts.includes(artifact))

  const issues: string[] = []
  if (missingPlanned.length > 0) {
    issues.push(
      `BLUEPRINT ARTIFACT COVERAGE FAILED: ${blueprintPath} is missing planned artifact declarations ${missingPlanned.join(", ")}`,
    )
  }
  if (undeclaredExtras.length > 0) {
    issues.push(
      `BLUEPRINT ARTIFACT DRIFT: ${blueprintPath} declares files not present in the plan targetArtifacts (${undeclaredExtras.join(", ")})`,
    )
  }
  return issues
}

type IntegrationProbe = (ctx: IntegrationProbeContext) => Promise<void>

function collectIntegrationArtifacts(plan: Plan): IntegrationArtifact[] {
  const artifacts: IntegrationArtifact[] = []
  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    for (const artifact of sa.executionContext.targetArtifacts) {
      artifacts.push({ path: artifact, stepName: step.name })
    }
  }
  return artifacts
}

async function probeWebEntrypointRuntimeWiring(ctx: IntegrationProbeContext): Promise<void> {
  const { plan, toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

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
      const raw = await readArtifactContent(readFile, probe.resolvedPath, runCommand)
      if (typeof raw !== "string" || raw.length === 0) continue
      htmlContent = raw
    } catch { continue }

    // Find JS files that should be loaded by this HTML
    // Only check JS artifacts from the same project (same directory tree)
    const htmlDir = htmlEntry.path.replace(/[^/]+$/, "")
    const relatedJs = jsArtifacts.filter(js => {
      const jsDir = js.path.replace(/[^/]+$/, "")
      // Only consider JS files that live in the same directory or a subdirectory
      // of the HTML file.  JS files that sit in a *parent* directory are
      // typically Node.js backend entry points (server.js, app.js …) and are
      // never loaded by the browser via <script> tags.
      return jsDir.startsWith(htmlDir)
    })

    if (relatedJs.length === 0) continue

    const scriptRefs = extractHtmlScriptRefs(htmlContent)
    const relatedJsContent = await readIntegrationArtifactContents(relatedJs, readFile, runCommand)
    const reachableRuntimeArtifacts = collectReachableRuntimeArtifacts(htmlEntry.path, scriptRefs, relatedJs, relatedJsContent)

    const missingScripts: string[] = []
    for (const jsEntry of relatedJs) {
      if (!reachableRuntimeArtifacts.has(normalizeSpecPath(jsEntry.path))) {
        const jsBasename = jsEntry.path.split("/").pop() ?? jsEntry.path
        missingScripts.push(jsBasename)
      }
    }

    if (missingScripts.length > 0) {
      // Find the assessment for the HTML-owning step and replace it with integration issue
      const idx = assessments.findIndex(a => a.stepName === htmlEntry.stepName)
      const issue = `Integration gap: entry artifact "${htmlEntry.path}" does not reach related runtime artifacts through module scripts/imports: ${missingScripts.join(", ")}. Runtime code will never load.`
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

    // Check that every <script src=...> and <link href=...> reference in the HTML
    // actually exists on disk. A missing file causes a silent browser 404 that
    // prevents the page from loading — the board never renders, JS never executes.
    const missingRefIssues: string[] = []
    const htmlDirForRef = htmlEntry.path.replace(/[^/]+$/, "")
    for (const scriptRef of scriptRefs) {
      const src = scriptRef.src
      // Skip absolute URLs (http/https/data/blob) and protocol-relative refs
      if (/^(?:https?|data|blob):|\/\//i.test(src)) continue
      // Resolve relative to the HTML file's directory
      const resolvedSrc = src.startsWith("/") ? src.replace(/^\//, "") : `${htmlDirForRef}${src}`
      const existsProbe = await probeArtifact(readFile, resolvedSrc, [], wsRoot, runCommand)
      if (!existsProbe.found) {
        missingRefIssues.push(
          `MISSING_SCRIPT_FILE: "${htmlEntry.path}" has <script src="${src}"> but "${resolvedSrc}" does not exist on disk. ` +
          `The browser will 404 and the page will be non-functional. Either write the missing file or remove the reference.`,
        )
      }
    }
    // Also check <link rel="stylesheet" href=...> references
    for (const match of htmlContent.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/giu)) {
      const href = match[1]
      if (/^(?:https?|data|blob):|\/\//i.test(href)) continue
      if (href.startsWith("//fonts.googleapis") || href.startsWith("//fonts.gstatic")) continue
      const resolvedHref = href.startsWith("/") ? href.replace(/^\//, "") : `${htmlDirForRef}${href}`
      const existsProbe = await probeArtifact(readFile, resolvedHref, [], wsRoot, runCommand)
      if (!existsProbe.found) {
        missingRefIssues.push(
          `MISSING_STYLESHEET_FILE: "${htmlEntry.path}" has <link href="${href}"> but "${resolvedHref}" does not exist on disk. ` +
          `Styles will be missing. Either write the missing CSS file or remove the reference.`,
        )
      }
    }
    if (missingRefIssues.length > 0) {
      const idx = assessments.findIndex(a => a.stepName === htmlEntry.stepName)
      if (idx >= 0) {
        const existing = assessments[idx]
        assessments[idx] = {
          stepName: existing.stepName,
          outcome: "retry",
          confidence: 0.0,
          issues: [...existing.issues, ...missingRefIssues],
          retryable: true,
        }
      }
    }
  }
}

async function probeBrowserModuleCompatibility(ctx: IntegrationProbeContext): Promise<void> {
  const { plan, toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  const htmlArtifacts = allArtifacts.filter(a => /\.(?:html?|xhtml)$/i.test(a.path))
  const jsArtifacts = allArtifacts.filter(a => /\.js$/i.test(a.path))
  if (htmlArtifacts.length === 0 || jsArtifacts.length === 0) return

  for (const htmlEntry of htmlArtifacts) {
    const wsRoot = findWsRootForStep(plan, htmlEntry.stepName)
    const htmlProbe = await probeArtifact(readFile, htmlEntry.path, [], wsRoot, runCommand)
    if (!htmlProbe.found) continue

    let htmlContent: string
    try {
      const raw = await readArtifactContent(readFile, htmlProbe.resolvedPath, runCommand)
      if (typeof raw !== "string" || raw.length === 0) continue
      htmlContent = raw
    } catch {
      continue
    }

    const htmlDir = htmlEntry.path.replace(/[^/]+$/, "")
    const relatedJs = jsArtifacts.filter(js => {
      const jsDir = js.path.replace(/[^/]+$/, "")
      return jsDir.startsWith(htmlDir) || htmlDir.startsWith(jsDir)
    })
    if (relatedJs.length === 0) continue

    const scriptRefs = extractHtmlScriptRefs(htmlContent)
    const relatedJsContent = await readIntegrationArtifactContents(relatedJs, readFile, runCommand)
    const reachableRuntimeArtifacts = collectReachableRuntimeArtifacts(htmlEntry.path, scriptRefs, relatedJs, relatedJsContent)
    const htmlIssues: string[] = []

    for (const scriptRef of scriptRefs) {
      const resolved = resolveArtifactReference(htmlEntry.path, scriptRef.src, relatedJs)
      if (!resolved || !/\.js$/i.test(resolved.path)) continue
      if (!scriptRef.isModule) {
        // Only flag when the JS file ACTUALLY contains ES module import/export syntax.
        // Plain scripts (no import/export) are correctly loaded without type="module".
        // Falsely flagging plain scripts causes agents to add type="module" which
        // breaks execution for file:// URLs (Chrome CORS-blocks module scripts).
        const resolvedJsContent = relatedJsContent.get(normalizeSpecPath(resolved.path)) ?? ""
        const usesEsModuleSyntax = /\bimport\s+(?:\{|[\w*]|\*\s+as\s+\w)|\bexport\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|\{)/.test(resolvedJsContent)
        if (!usesEsModuleSyntax) continue
        htmlIssues.push(
          `Browser module mismatch: "${htmlEntry.path}" loads "${resolved.basename}" without type="module", ` +
          `but the file uses ES module import/export syntax. ` +
          `Fix one of: (a) change the HTML tag to <script type="module" src="${resolved.basename}"> and ensure imports resolve via HTTP, ` +
          `or (b) remove all import/export statements and inline helper code into a single script file ` +
          `(simpler and more portable for bundled games and static tools).`,
        )
      }
    }

    for (const jsEntry of relatedJs) {
      const normalizedPath = normalizeSpecPath(jsEntry.path)
      if (!reachableRuntimeArtifacts.has(normalizedPath)) continue

      const jsBasename = jsEntry.path.split("/").pop() ?? jsEntry.path
      const jsContent = relatedJsContent.get(normalizedPath) ?? ""
      if (!jsContent) continue

      const usesCommonJs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]\w*\b|\brequire\s*\(/.test(jsContent)
      const usesWindowGlobals = /\bwindow\.[A-Za-z_$]\w*\s*=/.test(jsContent)

      if (usesCommonJs) {
        htmlIssues.push(
          `Browser module mismatch: "${htmlEntry.path}" reaches "${jsBasename}", but that file uses CommonJS (module.exports/require). Browser runtime files must use ES modules only.`,
        )
      }
      if (usesWindowGlobals) {
        htmlIssues.push(
          `Browser module mismatch: "${htmlEntry.path}" reaches "${jsBasename}", but that file assigns browser globals instead of using ESM imports/exports.`,
        )
      }
    }

    if (htmlIssues.length === 0) continue
    const idx = assessments.findIndex(a => a.stepName === htmlEntry.stepName)
    if (idx >= 0) {
      const existing = assessments[idx]
      assessments[idx] = {
        stepName: existing.stepName,
        outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
        confidence: existing.outcome === "pass" ? 0.35 : existing.confidence,
        issues: [...existing.issues, ...htmlIssues.filter(issue => !existing.issues.includes(issue))],
        retryable: true,
      }
    }
  }
}

async function probeCssClassContracts(ctx: IntegrationProbeContext): Promise<void> {
  const { plan, toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  const cssArtifacts = allArtifacts.filter(a => /\.(?:css|scss|sass|less)$/i.test(a.path))
  const codeArtifacts = allArtifacts.filter(a => /\.(?:js|jsx|ts|tsx|mjs|html?)$/i.test(a.path))
  if (cssArtifacts.length === 0 || codeArtifacts.length === 0) return

  const cssContents = await readIntegrationArtifactContents(cssArtifacts, readFile, runCommand)
  if (cssContents.size === 0) return

  const definedClasses = new Set<string>()
  for (const content of cssContents.values()) {
    for (const cls of extractDefinedCssClasses(content)) definedClasses.add(cls)
  }

  for (const artifact of codeArtifacts) {
    const wsRoot = findWsRootForStep(plan, artifact.stepName)
    const probe = await probeArtifact(readFile, artifact.path, [], wsRoot, runCommand)
    if (!probe.found) continue
    const content = await readArtifactContent(readFile, probe.resolvedPath, runCommand)
    if (typeof content !== "string" || content.length === 0) continue

    const referencedClasses = /\.html?$/i.test(artifact.path)
      ? extractReferencedCssClassesFromHtml(content)
      : extractReferencedCssClassesFromScript(content)
    const missingClasses = referencedClasses.filter(cls => !definedClasses.has(cls))
    if (missingClasses.length === 0) continue

    const idx = assessments.findIndex(a => a.stepName === artifact.stepName)
    if (idx < 0) continue

    const existing = assessments[idx]
    const issues = missingClasses.map(cls =>
      `Style integration gap: "${artifact.path}" references CSS class ".${cls}" for UI structure/state, but no related stylesheet defines it.`,
    )
    assessments[idx] = {
      stepName: existing.stepName,
      outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
      confidence: existing.outcome === "pass" ? 0.45 : existing.confidence,
      issues: [...existing.issues, ...issues.filter(issue => !existing.issues.includes(issue))],
      retryable: true,
    }
  }
}

function extractHtmlScriptRefs(htmlContent: string): Array<{ src: string; isModule: boolean }> {
  const refs: Array<{ src: string; isModule: boolean }> = []
  const scriptTagRe = /<script\b([^>]*)src\s*=\s*["']([^"']+)["']([^>]*)>/gi
  let match: RegExpExecArray | null
  while ((match = scriptTagRe.exec(htmlContent)) !== null) {
    const attrs = `${match[1] ?? ""} ${match[3] ?? ""}`
    refs.push({
      src: match[2],
      isModule: /\btype\s*=\s*["']module["']/i.test(attrs),
    })
  }
  return refs
}

async function probeLocalModuleImportBindings(ctx: IntegrationProbeContext): Promise<void> {
  const { toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (!readFile) return

  const codeArtifacts = allArtifacts.filter(a => /\.(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(a.path))
  if (codeArtifacts.length < 2) return

  const fileContents = await readIntegrationArtifactContents(codeArtifacts, readFile, runCommand)
  if (fileContents.size < 2) return

  const exportMap = new Map<string, { named: Set<string>; hasDefault: boolean }>()
  for (const artifact of codeArtifacts) {
    const normalizedPath = normalizeSpecPath(artifact.path)
    const content = fileContents.get(normalizedPath)
    if (!content) continue
    exportMap.set(normalizedPath, extractModuleExports(content))
  }

  for (const artifact of codeArtifacts) {
    const normalizedPath = normalizeSpecPath(artifact.path)
    const content = fileContents.get(normalizedPath)
    if (!content) continue

    const issues: string[] = []
    const imports = extractModuleImports(content)
    for (const imported of imports) {
      const resolved = resolveArtifactImport(normalizedPath, imported.specifier, codeArtifacts)
      if (!resolved) continue
      const exports = exportMap.get(resolved.path)
      if (!exports) continue

      if (imported.defaultImport && !exports.hasDefault) {
        issues.push(`Import/export mismatch: ${artifact.path} imports default from ${resolved.basename}, but that module has no default export`)
      }
      for (const importedName of imported.importedNames) {
        if (!exports.named.has(importedName)) {
          issues.push(`Import/export mismatch: ${artifact.path} imports ${importedName} from ${resolved.basename}, but that export is missing`)
        }
      }
    }

    if (issues.length === 0) continue
    const idx = assessments.findIndex(a => a.stepName === artifact.stepName)
    if (idx >= 0) {
      const existing = assessments[idx]
      assessments[idx] = {
        stepName: existing.stepName,
        outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
        confidence: existing.outcome === "pass" ? 0.35 : existing.confidence,
        issues: [...existing.issues, ...issues.filter(issue => !existing.issues.includes(issue))],
        retryable: true,
      }
    }
  }
}

async function readIntegrationArtifactContents(
  artifacts: readonly IntegrationArtifact[],
  readFile: Tool,
  runCommand?: Tool,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>()
  for (const artifact of artifacts) {
    try {
      const raw = await readArtifactContent(readFile, artifact.path, runCommand)
      if (typeof raw === "string" && raw.length > 0) {
        contents.set(normalizeSpecPath(artifact.path), raw)
      }
    } catch {
      // ignore unreadable artifacts here; other probes surface missing artifact failures
    }
  }
  return contents
}

function collectReachableRuntimeArtifacts(
  htmlPath: string,
  scriptRefs: readonly { src: string; isModule: boolean }[],
  relatedJs: readonly IntegrationArtifact[],
  contents: ReadonlyMap<string, string>,
): Set<string> {
  const reachable = new Set<string>()
  const queue: string[] = []

  for (const scriptRef of scriptRefs) {
    const resolved = resolveArtifactReference(htmlPath, scriptRef.src, relatedJs)
    if (!resolved) continue
    if (!reachable.has(resolved.path)) {
      reachable.add(resolved.path)
      queue.push(resolved.path)
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!
    const content = contents.get(current)
    if (!content) continue
    for (const imported of extractModuleImports(content)) {
      const resolved = resolveArtifactImport(current, imported.specifier, relatedJs)
      if (!resolved || reachable.has(resolved.path)) continue
      reachable.add(resolved.path)
      queue.push(resolved.path)
    }
  }

  return reachable
}

function resolveArtifactReference(
  fromArtifactPath: string,
  reference: string,
  artifacts: readonly IntegrationArtifact[],
): { path: string; basename: string } | null {
  const normalizedRef = reference.trim().replace(/^\.\//, "")
  if (!normalizedRef) return null
  const normalizedFrom = normalizeSpecPath(fromArtifactPath)
  const byRelativePath = normalizeSpecPath(pathPosix.join(pathPosix.dirname(normalizedFrom), normalizedRef))
  const candidates = [normalizedRef, byRelativePath]

  for (const candidate of candidates) {
    const match = artifacts.find(artifact => normalizeSpecPath(artifact.path) === candidate)
    if (match) {
      return { path: normalizeSpecPath(match.path), basename: match.path.split("/").pop() ?? match.path }
    }
  }

  const basename = normalizedRef.split("/").pop() ?? normalizedRef
  const basenameMatches = artifacts.filter(artifact => (artifact.path.split("/").pop() ?? artifact.path) === basename)
  if (basenameMatches.length === 1) {
    const match = basenameMatches[0]
    return { path: normalizeSpecPath(match.path), basename }
  }
  return null
}

function resolveArtifactImport(
  fromArtifactPath: string,
  specifier: string,
  artifacts: readonly IntegrationArtifact[],
): { path: string; basename: string } | null {
  if (!specifier.startsWith(".")) return null
  return resolveArtifactReference(fromArtifactPath, specifier, artifacts)
}

function extractModuleImports(code: string): ModuleImportRef[] {
  const imports: ModuleImportRef[] = []
  const importFromRe = /import\s+([^;\n]+?)\s+from\s+["']([^"']+)["']/g
  const sideEffectImportRe = /import\s+["']([^"']+)["']/g
  const exportFromRe = /export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g
  const exportAllFromRe = /export\s+\*\s+from\s+["']([^"']+)["']/g
  const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g

  let match: RegExpExecArray | null
  while ((match = importFromRe.exec(code)) !== null) {
    const clause = (match[1] ?? "").trim()
    const specifier = match[2]
    const importedNames: string[] = []
    let defaultImport: string | undefined
    let namespaceImport: string | undefined

    if (clause.startsWith("{")) {
      importedNames.push(...parseNamedImports(clause))
    } else if (clause.startsWith("* as ")) {
      namespaceImport = clause.replace(/^\*\s+as\s+/, "").trim()
    } else if (clause.includes(",")) {
      const [first, second] = clause.split(",", 2)
      defaultImport = first.trim() || undefined
      const rest = second.trim()
      if (rest.startsWith("{")) importedNames.push(...parseNamedImports(rest))
      if (rest.startsWith("* as ")) namespaceImport = rest.replace(/^\*\s+as\s+/, "").trim()
    } else {
      defaultImport = clause.trim() || undefined
    }

    imports.push({ specifier, importedNames, defaultImport, namespaceImport })
  }

  while ((match = sideEffectImportRe.exec(code)) !== null) {
    const specifier = match[1]
    if (!imports.some(entry => entry.specifier === specifier && entry.importedNames.length === 0 && !entry.defaultImport && !entry.namespaceImport)) {
      imports.push({ specifier, importedNames: [] })
    }
  }

  while ((match = exportFromRe.exec(code)) !== null) {
    imports.push({ specifier: match[2], importedNames: parseNamedImports(`{${match[1]}}`) })
  }

  while ((match = exportAllFromRe.exec(code)) !== null) {
    imports.push({ specifier: match[1], importedNames: [] })
  }

  while ((match = dynamicImportRe.exec(code)) !== null) {
    imports.push({ specifier: match[1], importedNames: [] })
  }

  return imports
}

function parseNamedImports(clause: string): string[] {
  const body = clause.replace(/^\{/, "").replace(/\}$/, "")
  return body
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => entry.split(/\s+as\s+/i)[0]?.trim() ?? "")
    .filter(Boolean)
}

function extractModuleExports(code: string): { named: Set<string>; hasDefault: boolean } {
  const named = new Set<string>()
  let hasDefault = false

  const exportFunctionRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$]\w*)\s*\(/g
  const exportClassRe = /export\s+class\s+([A-Za-z_$]\w*)\b/g
  const exportDeclRe = /export\s+(?:const|let|var)\s+([A-Za-z_$]\w*)\b/g
  const exportNamedRe = /export\s+\{([^}]+)\}/g
  const exportDefaultRe = /export\s+default\b/g

  let match: RegExpExecArray | null
  while ((match = exportFunctionRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportClassRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportDeclRe.exec(code)) !== null) named.add(match[1])
  while ((match = exportNamedRe.exec(code)) !== null) {
    for (const entry of match[1].split(",")) {
      const localName = entry.split(/\s+as\s+/i)[0]?.trim()
      if (localName) named.add(localName)
    }
  }
  while (exportDefaultRe.exec(code) !== null) hasDefault = true

  return { named, hasDefault }
}

/**
 * Integration probe: Cross-file function signature validation.
 *
 * Scans all JS/TS artifacts in the plan and checks that function calls in one
 * file match the actual function definitions in other files (name + arity).
 * This catches the "API drift" problem where Agent A writes `movePiece(from, to)`
 * but Agent B calls `movePiece(piece, fromRow, fromCol, toRow, toCol)`.
 */
async function probeCrossFileFunctionSignatures(ctx: IntegrationProbeContext): Promise<void> {
  const { toolMap, assessments, allArtifacts } = ctx
  const readFile = toolMap.get("read_file")
  if (!readFile) return

  const codeArtifacts = allArtifacts.filter(a => /\.(js|jsx|ts|tsx)$/i.test(a.path))
  if (codeArtifacts.length < 2) return

  // Read all code files
  const fileContents = new Map<string, { content: string; stepName: string }>()
  for (const artifact of codeArtifacts) {
    try {
      const raw = await readArtifactContent(readFile, artifact.path, toolMap.get("run_command"))
      if (typeof raw === "string" && raw.length > 0) {
        fileContents.set(artifact.path, { content: raw, stepName: artifact.stepName })
      }
    } catch { /* skip unreadable files */ }
  }

  if (fileContents.size < 2) return

  // Extract function definitions from all files
  const definitions = new Map<string, { file: string; stepName: string; params: number }>()
  const BUILTIN_RE = /^(if|for|while|switch|return|catch|new|typeof|import|require|console|document|window|Math|Array|Object|String|Date|JSON|Promise|setTimeout|setInterval|requestAnimationFrame|parseInt|parseFloat|alert|Error|Map|Set|WeakMap|WeakRef|Symbol|Proxy|Reflect|Number|Boolean|RegExp|Function|eval|isNaN|isFinite|decodeURI|encodeURI|atob|btoa|fetch|Response|Request|URL|URLSearchParams|AbortController|TextEncoder|TextDecoder|Blob|File|FileReader|FormData|crypto|performance|navigator|location|history|screen|localStorage|sessionStorage|indexedDB|Worker|SharedWorker|MessageChannel|MessagePort|BroadcastChannel|EventSource|WebSocket|XMLHttpRequest|IntersectionObserver|MutationObserver|ResizeObserver|Image|Audio|Video|Canvas|CanvasRenderingContext2D|Path2D|createTextNode|createDocumentFragment|querySelectorAll|querySelector|getElementById|getElementsByClassName|getElementsByTagName|createElement|appendChild|removeChild|insertBefore|replaceChild|cloneNode|hasChildNodes|addEventListener|removeEventListener|dispatchEvent|preventDefault|stopPropagation|toString|valueOf|hasOwnProperty|getPrototypeOf|keys|values|entries|assign|freeze|create|defineProperty|getOwnPropertyDescriptor|is|from|isArray|of|resolve|reject|all|allSettled|race|any|then|finally|log|warn|error|info|debug|table|trace|assert|clear|count|dir|group|groupEnd|time|timeEnd|timeLog|startsWith|endsWith|includes|indexOf|lastIndexOf|match|replace|replaceAll|search|split|trim|trimStart|trimEnd|padStart|padEnd|repeat|charAt|charCodeAt|codePointAt|normalize|toUpperCase|toLowerCase|toLocaleUpperCase|toLocaleLowerCase|concat|substring|slice|at|flat|flatMap|fill|find|findIndex|findLast|findLastIndex|every|some|reduce|reduceRight|sort|reverse|splice|unshift|shift|pop|push|map|filter|forEach|join|length|abs|ceil|floor|round|max|min|pow|sqrt|random|sign|trunc|cbrt|log2|log10|exp|sin|cos|tan|asin|acos|atan|atan2|PI|E|stringify|parse|now|getTime|getDate|getMonth|getFullYear|getHours|getMinutes|getSeconds|getMilliseconds|toISOString|toLocaleDateString|toLocaleTimeString|setItem|getItem|removeItem|test|exec|super|this|self|globalThis|undefined|null|NaN|Infinity|true|false|void|delete|instanceof|in|class|extends|static|get|set|async|await|yield|throw|try|break|continue|do|else|export|default|with|debugger|let|var|const|of|arguments)$/

  for (const [filePath, { content, stepName }] of fileContents) {
    // Match: function name(...), const name = (...) =>, name: function(...)
    const defPatterns = [
      /function\s+(\w+)\s*\(([^)]*)\)/g,
      /(?:const|let|var)\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/g,
      /(?:const|let|var)\s+(\w+)\s*=\s*function\s*\(([^)]*)\)/g,
      /(\w+)\s*\(([^)]*)\)\s*\{/g,  // method definitions in classes/objects
    ]

    for (const pattern of defPatterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1]
        const paramsStr = match[2] ?? ""
        if (!name || name.length < 2) continue
        if (BUILTIN_RE.test(name)) continue
        const paramCount = paramsStr.trim() === "" ? 0 : paramsStr.split(",").length
        // Only track the first definition found (avoid overwriting)
        if (!definitions.has(name)) {
          definitions.set(name, { file: filePath, stepName, params: paramCount })
        }
      }
    }
  }

  // Now check cross-file calls
  const mismatches: { callerFile: string; callerStep: string; defFile: string; defStep: string; name: string; expectedParams: number; actualArgs: number }[] = []

  for (const [filePath, { content, stepName }] of fileContents) {
    const callRegex = /\b(\w+)\s*\(([^)]*)\)/g
    let match: RegExpExecArray | null
    while ((match = callRegex.exec(content)) !== null) {
      const name = match[1]
      const argsStr = match[2]
      if (!name || name.length < 2) continue
      if (BUILTIN_RE.test(name)) continue

      const def = definitions.get(name)
      if (!def || def.file === filePath) continue

      const argCount = argsStr.trim() === "" ? 0 : argsStr.split(",").length
      if (def.params !== argCount) {
        mismatches.push({
          callerFile: filePath,
          callerStep: stepName,
          defFile: def.file,
          defStep: def.stepName,
          name,
          expectedParams: def.params,
          actualArgs: argCount,
        })
      }
    }
  }

  if (mismatches.length === 0) return

  // Group mismatches by caller step and inject issues
  for (const mm of mismatches) {
    const issue = `Cross-file signature mismatch: "${mm.name}" defined in ${mm.defFile} with ${mm.expectedParams} param(s) but called from ${mm.callerFile} with ${mm.actualArgs} arg(s)`
    const idx = assessments.findIndex(a => a.stepName === mm.callerStep)
    if (idx >= 0) {
      const existing = assessments[idx]
      // Avoid duplicate issues
      if (!existing.issues.includes(issue)) {
        assessments[idx] = {
          stepName: existing.stepName,
          outcome: existing.outcome === "pass" ? "retry" : existing.outcome,
          confidence: existing.outcome === "pass" ? 0.3 : existing.confidence,
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

/**
 * Domain-agnostic probe: infer required verification modalities from declared
 * outcomes and produced artifacts, then ensure they were actually executed.
 */
function detectVerificationModalityGaps(
  step: SubagentTaskStep,
  executedModalities: ReadonlySet<string>,
  toolMap: Map<string, Tool>,
): string[] {
  const issues: string[] = []
  const artifacts = step.executionContext.targetArtifacts
  const docsOnlyArtifacts = artifacts.length > 0 && artifacts.every(a => /\.(?:md|markdown|txt|rst|adoc)$/i.test(a))
  const hasHtml = artifacts.some(a => /\.html?$/i.test(a))
  const hasCode = artifacts.some(a => /\.(?:js|jsx|ts|tsx|py|rb|java|cs|go|rs|c|cpp|swift|kt|php)$/i.test(a))

  const criteriaText = [step.objective, ...step.acceptanceCriteria].join(" ").toLowerCase()
  const INTERACTION_RUNTIME_RE = /\b(?:click|submit|drag|drop|keyboard|mouse|navigate|interactive|render|display|preview|execute|run|workflow|integration|e2e|end[- ]to[- ]end)\b/i
  const IO_RUNTIME_RE = /\b(?:api|request|response|endpoint|fetch|http|rpc|query|database|sql|persist|sync|connect|auth|login|permission)\b/i

  const requiresArtifactReview = artifacts.length > 0
  const requiresSyntax = hasCode
  const requiresRuntime = !docsOnlyArtifacts && (hasHtml || INTERACTION_RUNTIME_RE.test(criteriaText) || IO_RUNTIME_RE.test(criteriaText))

  if (requiresArtifactReview && !executedModalities.has("artifact-review")) {
    if (toolMap.has("read_file")) {
      issues.push("VERIFICATION MODALITY GAP: target artifacts were produced but no deterministic artifact read/review probe ran")
    }
  }

  if (requiresSyntax && !executedModalities.has("syntax")) {
    if (toolMap.has("run_command")) {
      issues.push("VERIFICATION MODALITY GAP: code artifacts exist but no syntax/compile probe ran")
    } else {
      issues.push("VERIFICATION MODALITY GAP: code artifacts exist but syntax probe could not run (run_command unavailable)")
    }
  }

  if (requiresRuntime && !executedModalities.has("runtime")) {
    if (hasHtml && !toolMap.has("browser_check")) {
      issues.push("VERIFICATION MODALITY GAP: runtime behavior required for HTML output but browser_check tool is unavailable")
    } else {
      issues.push("VERIFICATION MODALITY GAP: acceptance criteria imply runtime behavior, but no runtime probe (browser_check/tests/command) ran")
    }
  }

  return issues
}

// ============================================================================
// Deterministic code structure analysis
// ============================================================================

/**
 * Language keywords that are built into the language — never "missing imports".
 * Keyed by the canonical extension group.
 */
const LANG_KEYWORDS: Record<string, Set<string>> = {
  js: new Set([
    "abstract","arguments","as","async","await","boolean","break","byte",
    "case","catch","char","class","const","continue","debugger","default",
    "delete","do","double","else","enum","eval","export","extends","false",
    "final","finally","float","for","from","function","goto","if","implements",
    "import","in","instanceof","int","interface","let","long","native","new",
    "null","of","package","private","protected","public","return","short",
    "static","super","switch","synchronized","this","throw","throws",
    "transient","true","try","type","typeof","undefined","var","void",
    "volatile","while","with","yield",
    // TypeScript extras
    "declare","namespace","module","readonly","keyof","infer","never",
    "unknown","any","object","string","number","bigint","symbol","satisfies",
  ]),
  python: new Set([
    "False","None","True","and","as","assert","async","await","break","class",
    "continue","def","del","elif","else","except","finally","for","from",
    "global","if","import","in","is","lambda","nonlocal","not","or","pass",
    "raise","return","try","while","with","yield",
  ]),
}

/** Browser/Node globals that are always in scope and never need importing */
const RUNTIME_GLOBALS = new Set([
  "console","window","document","process","global","module","exports",
  "require","__dirname","__filename",
  "Promise","Array","Object","String","Number","Boolean","BigInt","Symbol",
  "Math","JSON","Date","RegExp","Error","Map","Set","WeakMap","WeakSet",
  "Proxy","Reflect","Buffer","URL","URLSearchParams","TextEncoder","TextDecoder",
  "setTimeout","setInterval","clearTimeout","clearInterval","setImmediate",
  "fetch","XMLHttpRequest","FormData","Headers","Request","Response",
  "localStorage","sessionStorage","navigator","location","history",
  "performance","crypto","Intl","Event","CustomEvent","EventTarget",
  "parseInt","parseFloat","isNaN","isFinite","encodeURI","decodeURI",
  "encodeURIComponent","decodeURIComponent","atob","btoa","structuredClone",
])

interface CodeStructureAnalysis {
  language: string
  importedNames: string[]
  localDeclarations: string[]
  keywordsNote: string
}

/**
 * Deterministically extract the import and declaration structure of a JS/TS/PY
 * file so the LLM verifier never has to infer "is X a keyword or a missing
 * import?" — that distinction is resolved here, in code.
 *
 * Returns null for file types where we have no analysis (e.g. HTML, CSS).
 */
function analyzeCodeStructure(filePath: string, content: string): CodeStructureAnalysis | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  const isJS = ["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)
  const isPy = ext === "py"

  if (!isJS && !isPy) return null

  const keywords = isJS ? LANG_KEYWORDS.js : LANG_KEYWORDS.python
  const language = isJS ? (["ts", "tsx"].includes(ext) ? "TypeScript" : "JavaScript") : "Python"

  const importedNames: string[] = []

  if (isJS) {
    // ES module: import Foo from '...'
    for (const m of content.matchAll(/^import\s+(\w+)\s+from\s+['"][^'"]+['"]/gm))
      importedNames.push(m[1])
    // ES module: import { a, b as c } from '...'
    for (const m of content.matchAll(/^import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part.trim().split(/\s+as\s+/).pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
    // ES module: import * as ns from '...'
    for (const m of content.matchAll(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]+['"]/gm))
      importedNames.push(m[1])
    // CJS: const x = require('...')
    for (const m of content.matchAll(/const\s+(\w+)\s*=\s*require\s*\(/gm))
      importedNames.push(m[1])
    // CJS destructure: const { a, b } = require('...')
    for (const m of content.matchAll(/const\s+\{([^}]+)\}\s*=\s*require\s*\(/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part.trim().split(/\s+as\s+/).pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
  }

  if (isPy) {
    // from x import a, b  /  import x as y
    for (const m of content.matchAll(/^from\s+\S+\s+import\s+(.+)/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part.trim().split(/\s+as\s+/).pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
    for (const m of content.matchAll(/^import\s+(\w+)(?:\s+as\s+(\w+))?/gm))
      importedNames.push(m[2]?.trim() || m[1])
  }

  // Local declarations — functions, classes, variables and state destructuring
  const localDeclarations: string[] = []
  if (isJS) {
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g))
      localDeclarations.push(m[1])
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/g))
      localDeclarations.push(m[1])
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+(\w+)/g))
      localDeclarations.push(m[1])
    // useState / useReducer destructuring: const [x, setX] = ...
    for (const m of content.matchAll(/const\s+\[(\w+)\s*,\s*(\w+)\]\s*=/g)) {
      localDeclarations.push(m[1], m[2])
    }
  }
  if (isPy) {
    for (const m of content.matchAll(/(?:^|\n)\s*(?:async\s+)?def\s+(\w+)/g))
      localDeclarations.push(m[1])
    for (const m of content.matchAll(/(?:^|\n)\s*class\s+(\w+)/g))
      localDeclarations.push(m[1])
  }

  const uniqueImported = [...new Set(importedNames.filter(Boolean))]
  const uniqueLocal = [...new Set(localDeclarations.filter(Boolean))]
  const keywordsNote =
    `${language} built-in keywords (e.g. ${[...keywords].slice(0, 8).join(", ")}, …) ` +
    `and runtime globals (e.g. console, process, window, …) are always defined — never "missing".`

  return { language, importedNames: uniqueImported, localDeclarations: uniqueLocal, keywordsNote }
}

/**
 * Wrap raw artifact content with its deterministic structure analysis so the
 * LLM verifier sees clearly separated "pre-checked facts" vs "code to assess".
 */
function wrapArtifactWithStructureAnalysis(filePath: string, content: string): string {
  const analysis = analyzeCodeStructure(filePath, content)
  if (!analysis) {
    return `### ${filePath}\n\`\`\`\n${content}\n\`\`\``
  }

  const preChecked = [
    `Language: ${analysis.language}`,
    `Imports (pre-verified): ${analysis.importedNames.length > 0 ? analysis.importedNames.join(", ") : "(none)"}`,
    `Local declarations (pre-verified): ${analysis.localDeclarations.length > 0 ? analysis.localDeclarations.join(", ") : "(none)"}`,
    `Keywords note: ${analysis.keywordsNote}`,
  ].join("\n")

  return (
    `### ${filePath}\n` +
    `<!-- pre-checked structure (do NOT re-analyze imports or flag keywords) -->\n` +
    `\`\`\`\nPRE-CHECKED STRUCTURE:\n${preChecked}\n\`\`\`\n` +
    `\`\`\`\n${content}\n\`\`\``
  )
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
- SHALLOW IMPLEMENTATION IS NEVER "pass": If the acceptance criteria require complex logic (e.g. validation rules, state transitions, business workflows) but the code only has trivial/generic implementations (e.g. a validate function that always returns true, a UI update function that skips required checks), mark it "retry". READ THE ACTUAL CODE carefully — don't trust the child's self-reported summary.
- CODE LENGTH IS NOT A QUALITY METRIC: Compact, correct code is FINE. A 50-line file that correctly implements all acceptance criteria is better than a 300-line file with stubs. Judge by correctness and completeness, NOT by line count.
- When "Actual File Contents" are provided below the step results, YOU MUST read the actual code and verify EACH acceptance criterion is implemented with REAL logic. A function that exists but does the wrong thing is NOT passing.
- IMPORT AND KEYWORD ANALYSIS IS PRE-CHECKED: Every code artifact in the "Actual File Contents" section has a "PRE-CHECKED STRUCTURE" block showing its language, pre-verified imports, local declarations, and a keywords note. This was produced by a static analyzer — treat it as ground truth. Do NOT re-analyze import statements, do NOT flag language keywords (async, await, function, class, const, return, …) as missing imports, and do NOT flag state bindings created by destructuring (e.g. setClients from const [clients, setClients] = useState()) as undefined. Confine your import/symbol analysis to names that are absent from both "Imports (pre-verified)" and "Local declarations (pre-verified)" in the PRE-CHECKED STRUCTURE block.
- When "specEvidence" is provided for a step, treat it as the structured contract extracted from BLUEPRINT.md. Use its source-read evidence, file mappings, and missing-function findings when deciding whether the step actually followed the spec.
- When "specEvidence" is provided for a step, also use its structural markers and process-audit findings. If the child read BLUEPRINT.md only after mutating files, or never read it at all, treat that as strong evidence the spec was not actually used.
- EXPLICIT MAPPING REQUIRED: If a step claims to follow BLUEPRINT.md but the provided spec evidence shows unmapped target artifacts, path mismatches, or missing blueprint functions, do NOT mark the step as pass unless the actual code clearly satisfies the contract another way and you can explain that reasoning in the issues.
- STRUCTURAL FIRST: Use the blueprint's declared structural markers in a language-agnostic way. Depending on the artifact type, these may represent tags/components, functions/methods, classes/structs/interfaces, modules/packages/namespaces, shell commands, labels, or other named program structure. Missing structural markers are deterministic evidence against a pass, even if the child summary sounds plausible.
- GUARD ORDERING: Check that early-return guards in event handlers or dispatchers don't block valid interactions. Example: \`if (item.owner !== currentUser) return;\` at the top of a click handler prevents clicking on opponent items to interact with them (e.g. capture). The guard should be conditional on current state (e.g. only reject when no item is already selected).
- HELPER FUNCTION TRACING: For each key acceptance criterion, identify the function(s) that implement it and the helpers they call. Pick ONE concrete scenario and mentally trace the code path step by step, including into helper functions. Verify each helper returns the correct value for that scenario. A helper whose name implies a semantic (e.g. "isSameTeam", "isValid", "hasPermission", "belongsTo") must actually implement that semantic correctly — don't assume it works just because it has a body. Pay special attention to comparisons that erase important distinctions (e.g. case-insensitive comparison on data where case carries meaning).
- MISSING FEATURE DETECTION: For each acceptance criterion, verify there is ACTUAL CODE implementing it — not just a function with a matching name, but real logic. If a criterion requires session expiration logic but no code checks timestamps, that criterion is NOT met. If a criterion requires duplicate suppression but no code tracks prior ids, it is NOT met. List every criterion that is NOT implemented.
- Be practical: if the step produced working output that meets the core objective, mark it as pass even if minor polish is possible
- Only mark "retry" for specific, actionable issues — not vague concerns about quality
- If deterministic probes passed for a step, strongly prefer "pass" unless you see a clear problem in the actual code
- Evidence quality: outputs with concrete indicators (file paths, line numbers, error messages, data) are more trustworthy than vague summaries
- Hallucination check: if output claims "according to logs" or "as seen in" but doesn't match known artifacts, flag it
- BACKEND NOT RUNNING IS NOT A FAILURE: If browser_check shows ERR_CONNECTION_REFUSED or "Failed to fetch" to a localhost port (e.g. http://localhost:3001), this means the generated backend service is not running during verification. This is expected — it is NOT a code bug. Do NOT flag this as an issue. The generated backend code quality should be judged by reading the source, not by whether the server was started.
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
  opts?: {
    signal?: AbortSignal
    onTrace?: (entry: Record<string, unknown>) => void
    artifactContents?: ReadonlyMap<string, string>
    stepSpecEvidence?: ReadonlyMap<string, StepSpecEvidence>
  },
): Promise<VerifierDecision> {
  // Build verification context
  const stepSummaries = plan.steps.map(step => {
    const result = pipelineResult.stepResults.get(step.name)
    const detAssessment = deterministicAssessments.find(a => a.stepName === step.name)
    const specEvidence = opts?.stepSpecEvidence?.get(step.name)

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
      specEvidence: specEvidence ? {
        blueprintPath: specEvidence.blueprintPath,
        sourceReads: specEvidence.sourceReads,
        contractSharedTypes: specEvidence.contractSharedTypes.map((type) => ({
          name: type.name,
          definition: type.definition,
          usedBy: type.usedBy,
        })),
        sharedTypes: specEvidence.sharedTypes,
        algorithmicContracts: specEvidence.algorithmicContracts,
        mappings: specEvidence.mappings.map(mapping => ({
          targetArtifact: mapping.targetArtifact,
          actualArtifactPath: mapping.actualArtifactPath,
          matchedSpecPath: mapping.matchedSpecPath,
          pathMatch: mapping.pathMatch,
          foundFunctions: mapping.foundFunctions,
          missingFunctions: mapping.missingFunctions,
          foundStructuralMarkers: mapping.foundStructuralMarkers,
          missingStructuralMarkers: mapping.missingStructuralMarkers,
        })),
        structuralIssues: specEvidence.structuralIssues,
        processAuditIssues: specEvidence.processAuditIssues,
      } : undefined,
    }
  })

  // Build artifact content section for code files so the LLM can assess
  // whether the code actually implements the acceptance criteria.
  // Each artifact is wrapped with deterministic pre-checked structure (imports,
  // local declarations, keyword list) so the LLM never needs to infer whether
  // an identifier is a language keyword or a missing import — that separation
  // is resolved here, in code, before the LLM ever sees the file.
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
      parts.push(wrapArtifactWithStructureAnalysis(path, truncated))
    }
    artifactSection = `\n\n## Actual File Contents\nEach file includes a PRE-CHECKED STRUCTURE block. Trust that data — do NOT re-analyze imports or flag language keywords. Focus on semantic correctness against acceptance criteria.\n\n${parts.join("\n\n")}`
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
  opts?: { signal?: AbortSignal; onTrace?: (entry: Record<string, unknown>) => void; skipContractValidation?: boolean },
): Promise<VerifierDecision> {
  const finalizeAssessments = (
    assessments: readonly VerifierStepAssessment[],
    source: VerificationEvidence["source"],
  ): VerifierStepAssessment[] => {
    const evidenceByStep = collectVerificationEvidence(plan, assessments, source)
    const issuesByStep = deriveIssuesFromEvidence(plan, assessments, evidenceByStep)
    return assessments.map((assessment) => ({
      ...assessment,
      evidence: [...(evidenceByStep.get(assessment.stepName) ?? [])],
      issueDetails: [...(issuesByStep.get(assessment.stepName) ?? [])],
    }))
  }

  const knownProjectArtifacts = plan.steps
    .filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")
    .flatMap((s) => s.executionContext.targetArtifacts)

  // Phase 0: Delegation output contract validation
  // Fast, deterministic checks on child output structure + tool evidence.
  // These catch empty outputs, missing file mutations, contradictory claims, etc.
  // BEFORE spending tokens on LLM verification.
  const contractFailures: VerifierStepAssessment[] = []
  if (!opts?.skipContractValidation) {
    for (const step of plan.steps) {
      if (step.stepType !== "subagent_task") continue
      const sa = step as SubagentTaskStep
      const stepResult = pipelineResult.stepResults.get(step.name)
      if (!stepResult || stepResult.status === "skipped") continue

      const contractSpec = buildContractSpec(
        sa,
        sa.executionContext,
        undefined,
        knownProjectArtifacts,
      )
      const contractResult = validateDelegatedOutputContract({
        spec: contractSpec,
        output: stepResult.output ?? stepResult.error ?? "",
        toolCalls: stepResult.toolCalls,
      })

      if (stepResult.reconciliation && !stepResult.reconciliation.compliant) {
        contractFailures.push({
          stepName: step.name,
          outcome: "retry",
          confidence: 0.97,
          issues: stepResult.reconciliation.findings.map((finding) => `[reconciliation:${finding.code}] ${finding.message}`),
          retryable: true,
        })
        opts?.onTrace?.({
          kind: "verifier-reconciliation-check",
          stepName: step.name,
          findings: stepResult.reconciliation.findings.map((finding) => ({ code: finding.code, severity: finding.severity, message: finding.message })),
        })
        continue
      }

      if (!contractResult.ok && contractResult.code) {
        const guidance = getCorrectionGuidance(contractResult.code)
        contractFailures.push({
          stepName: step.name,
          outcome: "retry",
          confidence: 0.95,
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
    const enrichedSteps = finalizeAssessments(allSteps, "contract")
    return {
      overall: "retry",
      confidence: Math.min(...enrichedSteps.map(s => s.confidence)),
      steps: enrichedSteps,
      unresolvedItems: contractFailures.map(cf => cf.issues[0]),
    }
  }

  // Phase 1: Deterministic probes
  const detAssessments = finalizeAssessments(
    await runDeterministicProbes(plan, pipelineResult, tools),
    "deterministic",
  )

  // If deterministic probes already show clear failure, skip LLM verification
  const detFails = detAssessments.filter(a => a.outcome === "fail" || a.outcome === "retry")
  if (detFails.length > 0 && detFails.some(a => a.outcome === "fail")) {
    return buildFallbackDecision(detAssessments)
  }

  // Read actual file contents for code artifacts to give the LLM verifier
  // concrete code to assess (not just the child's self-reported output).
  // Use probeArtifact for path resolution — the planned paths are often bare
  // filenames (e.g. "gameLogic.js") but the actual files live in subdirectories
  // (e.g. "tmp/project/logic.js"). Without resolution the LLM verifier
  // gets zero code context and cannot assess quality.
  const artifactContents = new Map<string, string>()
  const stepSpecEvidence = new Map<string, StepSpecEvidence>()
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  if (readFile) {
    for (const step of plan.steps) {
      if (step.stepType !== "subagent_task") continue
      const sa = step as SubagentTaskStep
      const stepResult = pipelineResult.stepResults.get(step.name)
      if (stepResult?.status === "completed") {
        const actualPaths = stepResult.output ? extractActualPaths(stepResult.output) : []
        const specEvidence = await buildStepSpecEvidence(sa, stepResult, plan, readFile, runCommand, actualPaths)
        if (specEvidence) stepSpecEvidence.set(step.name, specEvidence)
      }
      // Gather actual paths from child output for better probe resolution
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
            const content = await readArtifactContent(readFile, probe.resolvedPath, runCommand)
            if (typeof content === "string" && content.length > 0) {
              artifactContents.set(artifact, content)
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  // Phase 2: LLM verification
  const decision = await runLLMVerification(llm, plan, pipelineResult, detAssessments, {
    signal: opts?.signal,
    onTrace: opts?.onTrace,
    artifactContents,
    stepSpecEvidence,
  })

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
  let enrichedMergedSteps = finalizeAssessments(mergedSteps, "llm")
  const followupCandidates = needsFollowupVerification(enrichedMergedSteps)
  if (followupCandidates.length > 0) {
    opts?.onTrace?.({
      kind: "planner-verification-followup",
      requestedSteps: followupCandidates.map((assessment) => assessment.stepName),
      reasons: followupCandidates.map((assessment) => ({
        stepName: assessment.stepName,
        confidence: assessment.confidence,
        ambiguousIssues: (assessment.issueDetails ?? []).filter((issue) => issue.ownershipMode !== "deterministic_owner").map((issue) => issue.code),
      })),
    })
    const followupEvidenceByStep = collectFollowupEvidence(plan, pipelineResult, followupCandidates)
    enrichedMergedSteps = mergeFollowupIntoAssessments(plan, enrichedMergedSteps, followupEvidenceByStep)
  }

  const systemChecks = buildSystemChecks({
    overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
    confidence: Math.min(decision.confidence, ...enrichedMergedSteps.map(s => s.confidence)),
    steps: enrichedMergedSteps,
    unresolvedItems: decision.unresolvedItems,
  })

  return {
    overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
    confidence: Math.min(decision.confidence, ...enrichedMergedSteps.map(s => s.confidence)),
    steps: enrichedMergedSteps,
    unresolvedItems: uniqueStrings([...decision.unresolvedItems, ...systemChecks.map((check) => check.summary)]),
    systemChecks,
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

const RESERVED_CALL_IDENTIFIERS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "new", "delete", "void",
  "function", "class", "super", "this", "await", "yield", "import", "export", "default",
  "require", "console", "document", "window", "globalThis", "Math", "JSON", "Object", "Array",
  "String", "Number", "Boolean", "Date", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol",
  "RegExp", "Error", "URL", "fetch", "parseInt", "parseFloat", "isNaN", "isFinite", "setTimeout",
  "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "addEventListener", "removeEventListener", "querySelector", "querySelectorAll", "getElementById",
  "createElement", "alert", "confirm", "prompt",
])

/**
 * Detect unresolved method references in class-based JS/TS code.
 *
 * When a child agent destructively rewrites a file, it often removes method
 * definitions while keeping calls to those methods in other methods. For example:
 *   - validateRecord() calls this.checkConstraints() but checkConstraints was deleted
 *   - processEvent() calls this.normalizePayload() but normalizePayload was deleted
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

function detectUnresolvedBareHelpers(code: string): string[] {
  const definitions = new Set<string>()
  const imports = new Set<string>()

  const functionDeclRe = /function\s+([a-zA-Z_$]\w*)\s*\(/g
  const classDeclRe = /class\s+([a-zA-Z_$]\w*)\b/g
  const variableDeclRe = /(?:const|let|var)\s+([a-zA-Z_$]\w*)\s*=/g
  const methodLikeRe = /(^|\n)\s*(?:export\s+)?(?:async\s+)?([a-zA-Z_$]\w*)\s*\([^)]*\)\s*\{/g
  const importNamedRe = /import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g
  const importDefaultRe = /import\s+([a-zA-Z_$]\w*)(?:\s*,\s*\{[^}]+\})?\s*from\s*["'][^"']+["']/g
  const importNamespaceRe = /import\s+\*\s+as\s+([a-zA-Z_$]\w*)\s+from\s*["'][^"']+["']/g

  let match: RegExpExecArray | null
  while ((match = functionDeclRe.exec(code)) !== null) definitions.add(match[1])
  while ((match = classDeclRe.exec(code)) !== null) definitions.add(match[1])
  while ((match = variableDeclRe.exec(code)) !== null) definitions.add(match[1])
  while ((match = methodLikeRe.exec(code)) !== null) {
    const name = match[2]
    if (name && !RESERVED_CALL_IDENTIFIERS.has(name)) definitions.add(name)
  }
  while ((match = importNamedRe.exec(code)) !== null) {
    const entries = match[1].split(",")
    for (const entry of entries) {
      const localName = entry.split(/\s+as\s+/i).pop()?.trim()
      if (localName) imports.add(localName)
    }
  }
  while ((match = importDefaultRe.exec(code)) !== null) imports.add(match[1])
  while ((match = importNamespaceRe.exec(code)) !== null) imports.add(match[1])

  const unresolved: string[] = []
  const bareCallRe = /([a-zA-Z_$]\w*)\s*\(/g
  while ((match = bareCallRe.exec(code)) !== null) {
    const name = match[1]
    if (!name) continue
    const prevChar = code[Math.max(0, match.index - 1)]
    if (prevChar && /[.\w$]/.test(prevChar)) continue
    if (definitions.has(name) || imports.has(name) || RESERVED_CALL_IDENTIFIERS.has(name) || BUILTIN_METHODS.has(name)) continue

    const before = code.slice(Math.max(0, match.index - 24), match.index + name.length + 1)
    if (/(?:function|class|new|if|for|while|switch|catch)\s+$/.test(before)) continue

    const issue = `${name}() called but not defined or imported in file`
    if (!unresolved.includes(issue)) unresolved.push(issue)
  }

  return unresolved.slice(0, 5)
}

function detectPotentialUseBeforeDeclaration(code: string): string[] {
  const issues: string[] = []
  const lines = code.split("\n")
  const declarations = new Map<string, number>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Only track module-level declarations (no leading whitespace before const/let).
    // Function-scoped variables (indented) share common names like row, col, from, to
    // as parameters across multiple functions — flagging them produces false positives.
    for (const match of line.matchAll(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$]\w*)\b/gm)) {
      const name = match[1]
      if (name && !declarations.has(name)) declarations.set(name, i)
    }
  }

  for (const [name, declLine] of declarations) {
    for (let i = 0; i < declLine; i++) {
      const line = lines[i]
      if (/^\s*(?:\/\/|\*)/.test(line)) continue
      const re = new RegExp(`(^|[^.\\w$])${escapeRegExp(name)}(?=[^\\w$]|$)`)
      const m = re.exec(line)
      if (!m) continue
      // Skip if the match is inside a string literal: the char preceding the
      // identifier (group 1) is a quote. E.g. getElementById('board') should
      // not be flagged as a reference to the `board` variable.
      if (m[1] === "'" || m[1] === '"' || m[1] === "`") continue
      if (new RegExp(`\b(?:const|let|var|function|class)\s+${escapeRegExp(name)}\b`).test(line)) continue
      issues.push(`${name} is referenced before its const/let declaration (line ${i + 1} before line ${declLine + 1})`)
      break
    }
  }

  return issues.slice(0, 5)
}

function extractDefinedCssClasses(css: string): string[] {
  const classes: string[] = []
  for (const match of css.matchAll(/\.([A-Za-z_-][\w-]*)\b/g)) {
    const cls = match[1]
    if (cls) classes.push(cls)
  }
  return uniqueStrings(classes)
}

function extractReferencedCssClassesFromScript(code: string): string[] {
  const classes: string[] = []
  for (const match of code.matchAll(/\bclassList\.(?:add|remove|toggle|contains)\s*\(([^)]*)\)/g)) {
    const args = match[1] ?? ""
    for (const str of args.matchAll(/["'`]([A-Za-z_-][\w-]*)["'`]/g)) {
      if (str[1]) classes.push(str[1])
    }
  }
  for (const match of code.matchAll(/\bclassName\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    const raw = match[1] ?? ""
    for (const token of raw.split(/\s+/)) {
      if (/^[A-Za-z_-][\w-]*$/.test(token)) classes.push(token)
    }
  }
  return uniqueStrings(classes)
}

function extractReferencedCssClassesFromHtml(html: string): string[] {
  const classes: string[] = []
  for (const match of html.matchAll(/\bclass\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    const raw = match[1] ?? ""
    for (const token of raw.split(/\s+/)) {
      if (/^[A-Za-z_-][\w-]*$/.test(token)) classes.push(token)
    }
  }
  return uniqueStrings(classes)
}

function detectPotentialLinearGridStriping(css: string): string[] {
  const issues: string[] = []
  const hasGridColumns = /grid-template-columns\s*:\s*repeat\s*\(\s*([2-9]|\d{2,})\s*,/i.test(css)
    || /grid-template-columns\s*:\s*(?:[^;]*\s){1,}[0-9.]+(?:fr|px|rem|em|%)\b/i.test(css)
  const usesFlatOddEven = /:nth-child\(odd\)/i.test(css) && /:nth-child\(even\)/i.test(css)
  const usesCoordinateAwareSelectors = /:nth-child\(\s*\d+n\s*[+-]\s*\d+\s*\)/i.test(css)
    || /\[(?:data-|aria-)[^\]]*(?:row|col|x|y|cell)/i.test(css)
    || /--(?:row|col|x|y)/i.test(css)

  if (hasGridColumns && usesFlatOddEven && !usesCoordinateAwareSelectors) {
    issues.push("alternating cell styling appears to rely on flat :nth-child(odd/even) selectors inside a multi-column grid, which often produces striping instead of true 2D alternation")
  }

  return issues
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

function isBlockingCriteriaProofGap(issue: string): boolean {
  if (!issue.includes("CRITERIA PROOF MISSING")) return false
  // Only block retryability for shared-state contract violations — these represent
  // a design error that retrying won't fix (missing requiredSourceArtifacts).
  // "Runtime criteria declared but no probe executed" is often a TOOL AVAILABILITY
  // gap (browser_check missing), not an agent failure — that case should be
  // retryable so the repair can use a different verification approach.
  return /shared-state contract requires/i.test(issue)
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
