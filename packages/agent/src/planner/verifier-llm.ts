/**
 * Verifier code structure analysis — deterministic import/declaration
 * extraction and LLM verification wrapper.
 *
 * Extracted from verifier.ts.
 *
 * @module
 */

import type { LLMClient, Message, Tool } from "../types.js"
import type {
    PipelineResult,
    Plan,
    SubagentTaskStep,
    VerifierDecision,
    VerifierStepAssessment,
} from "./types.js"
import type { StepSpecEvidence } from "./verifier-blueprint.js"
import { buildFallbackDecision, parseLLMVerification } from "./verifier-helpers.js"

// ============================================================================
// Deterministic code structure analysis
// ============================================================================

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

export interface CodeStructureAnalysis {
  language: string
  importedNames: string[]
  localDeclarations: string[]
  keywordsNote: string
}

export function analyzeCodeStructure(filePath: string, content: string): CodeStructureAnalysis | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  const isJS = ["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)
  const isPy = ext === "py"

  if (!isJS && !isPy) return null

  const keywords = isJS ? LANG_KEYWORDS.js : LANG_KEYWORDS.python
  const language = isJS ? (["ts", "tsx"].includes(ext) ? "TypeScript" : "JavaScript") : "Python"

  const importedNames: string[] = []

  if (isJS) {
    for (const m of content.matchAll(/^import\s+(\w+)\s+from\s+['"][^'"]+['"]/gm))
      importedNames.push(m[1])
    for (const m of content.matchAll(/^import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part.trim().split(/\s+as\s+/).pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
    for (const m of content.matchAll(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]+['"]/gm))
      importedNames.push(m[1])
    for (const m of content.matchAll(/const\s+(\w+)\s*=\s*require\s*\(/gm))
      importedNames.push(m[1])
    for (const m of content.matchAll(/const\s+\{([^}]+)\}\s*=\s*require\s*\(/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part.trim().split(/\s+as\s+/).pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
  }

  if (isPy) {
    for (const m of content.matchAll(/^from\s+\S+\s+import\s+(.+)/gm)) {
      for (const part of m[1].split(",")) {
        const alias = part.trim().split(/\s+as\s+/).pop()
        if (alias?.trim()) importedNames.push(alias.trim())
      }
    }
    for (const m of content.matchAll(/^import\s+(\w+)(?:\s+as\s+(\w+))?/gm))
      importedNames.push(m[2]?.trim() || m[1])
  }

  const localDeclarations: string[] = []
  if (isJS) {
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g))
      localDeclarations.push(m[1])
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/g))
      localDeclarations.push(m[1])
    for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+(\w+)/g))
      localDeclarations.push(m[1])
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

export function wrapArtifactWithStructureAnalysis(filePath: string, content: string, sizeNote = ""): string {
  const analysis = analyzeCodeStructure(filePath, content)
  if (!analysis) {
    return `### ${filePath}\n${sizeNote}\`\`\`\n${content}\n\`\`\``
  }

  const preChecked = [
    `Language: ${analysis.language}`,
    `Imports (pre-verified): ${analysis.importedNames.length > 0 ? analysis.importedNames.join(", ") : "(none)"}`,
    `Local declarations (pre-verified): ${analysis.localDeclarations.length > 0 ? analysis.localDeclarations.join(", ") : "(none)"}`,
    `Keywords note: ${analysis.keywordsNote}`,
  ].join("\n")

  return (
    `### ${filePath}\n` +
    (sizeNote ? sizeNote : "") +
    `<!-- pre-checked structure (do NOT re-analyze imports or flag keywords) -->\n` +
    `\`\`\`\nPRE-CHECKED STRUCTURE:\n${preChecked}\n\`\`\`\n` +
    `\`\`\`\n${content}\n\`\`\``
  )
}

// ============================================================================
// Verification modality gap detection
// ============================================================================

export function detectVerificationModalityGaps(
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
- SKELETON / PLACEHOLDER CODE IS NEVER "pass": If a step was supposed to implement logic but output contains placeholder functions, mark it "retry"
- LLM DEGENERATION IS NEVER "pass": Comments like \`// Other code as per existing logic\`, \`// rest of the code here\` mean the LLM skipped generating actual code
- SHALLOW IMPLEMENTATION IS NEVER "pass": If acceptance criteria require complex logic but code only has trivial implementations, mark it "retry"
- CODE LENGTH IS NOT A QUALITY METRIC: Compact, correct code is FINE
- IMPORT AND KEYWORD ANALYSIS IS PRE-CHECKED: Trust PRE-CHECKED STRUCTURE blocks in artifact sections
- TRUNCATION IS NOT INCOMPLETENESS: Files shown with "(truncated — head+tail)" are COMPLETE on disk. The head+tail view lets you verify correct start and end. Do NOT flag a file as incomplete, unverifiable, or suspect solely because it was truncated for context. Truncation is a display constraint, not a quality signal.
- POSITIVE SIGNAL OVERRIDE (MANDATORY): If a step's deterministicResult includes positiveSignals with "browser_check: ✓" or "syntax: ✓", you MUST NOT raise issues about "cannot verify completeness", "truncated evidence makes verification impossible", or "acceptance criterion cannot be verified from excerpt". Those signals are definitive proof the artifact is loadable/syntactically correct. Only raise real semantic issues (wrong logic, missing gameplay rules, etc.) that you can actually see in the artifact content.
- confidence is 0.0 to 1.0
- Respond ONLY with the JSON object`

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
        // Definitive positive signals from deterministic probes.
        // When present, do NOT raise truncation/completeness blocking issues.
        positiveSignals: detAssessment.positiveSignals ?? [],
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

  let artifactSection = ""
  if (opts?.artifactContents && opts.artifactContents.size > 0) {
    const parts: string[] = []
    for (const [path, content] of opts.artifactContents) {
      const totalBudget = 24_000
      const perArtifactLimit = Math.max(4000, Math.floor(totalBudget / opts.artifactContents.size))
      let displayContent: string
      let sizeNote = ""
      if (content.length > perArtifactLimit) {
        // Show head (75%) + tail (25%) so the verifier can confirm the file
        // both starts and ends correctly. A file complete on disk will have a
        // proper closing brace/statement in its tail.
        const lineCount = content.split("\n").length
        const headChars = Math.floor(perArtifactLimit * 0.75)
        const tailChars = perArtifactLimit - headChars
        const omittedChars = content.length - headChars - tailChars
        const head = content.slice(0, headChars)
        const tail = content.slice(-tailChars)
        displayContent = `${head}\n... (${omittedChars} chars omitted) ...\n${tail}`
        sizeNote = `File size: ${content.length} chars, ${lineCount} lines. TRUNCATED (head+tail shown — file is COMPLETE on disk, only display is trimmed).\n`
      } else {
        displayContent = content
      }
      parts.push(wrapArtifactWithStructureAnalysis(path, displayContent, sizeNote))
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

    const rawDecision = parseLLMVerification(response.content, deterministicAssessments)

    // Post-process: when deterministic probes gave positive signals (e.g. browser_check ✓),
    // downgrade any LLM issues that are purely uncertainty-based due to truncation.
    // These are false positives — the file works, the LLM just couldn't see its tail.
    const TRUNCATION_UNCERTAINTY_RE = /truncat|cannot verify.*complet|excerpt.*missing|complet.*unverif|acceptance.*criterion.*cannot.*verif|grounded.*evidence.*shows.*truncat|critical tail.*missing/i
    const downgraded = rawDecision.steps.map(step => {
      const detAssessment = deterministicAssessments.find(a => a.stepName === step.stepName)
      if (!detAssessment?.positiveSignals?.length) return step
      const hasStrongSignal = detAssessment.positiveSignals.some(s => /browser_check.*✓|syntax.*✓/i.test(s))
      if (!hasStrongSignal) return step
      const processedIssues = step.issues.map(issue =>
        !issue.startsWith("[non-blocking]") && TRUNCATION_UNCERTAINTY_RE.test(issue)
          ? `[non-blocking] ${issue}`
          : issue
      )
      const remainingBlocking = processedIssues.filter(i => !i.startsWith("[non-blocking]"))
      return {
        ...step,
        issues: processedIssues,
        outcome: remainingBlocking.length === 0 ? "pass" as const : step.outcome,
      }
    })

    const anyRetry = downgraded.some(s => s.outcome === "retry")
    const anyFail = downgraded.some(s => s.outcome === "fail")
    return {
      ...rawDecision,
      overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
      steps: downgraded,
    }
  } catch {
    return buildFallbackDecision(deterministicAssessments)
  }
}
