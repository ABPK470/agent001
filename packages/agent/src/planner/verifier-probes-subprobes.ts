/**
 * Content completeness and criteria proof sub-probes.
 * Private helpers extracted from verifier-probes.ts.
 *
 * @module
 */

import { detectPlaceholderPatterns } from "../code-quality.js"
import type { Tool } from "../types.js"
import type { SubagentTaskStep } from "./types.js"
import {
    detectCodeCorruption,
    detectHtmlCorruption,
    detectPotentialLinearGridStriping,
    detectPotentialUseBeforeDeclaration,
    detectUnresolvedBareHelpers,
    detectUnresolvedMethods,
} from "./verifier-helpers.js"
import { executeToolForText, readArtifactContent } from "./verifier-io.js"

// ============================================================================
// Content completeness sub-probe
// ============================================================================

export async function probeContentCompleteness(
  sa: SubagentTaskStep,
  readFile: Tool,
  runCommand: Tool | undefined,
  probeCache: Map<string, { found: boolean; resolvedPath: string }>,
  issues: string[],
  executedModalities: Set<string>,
): Promise<void> {
  const codeArtifacts = sa.executionContext.targetArtifacts.filter(
    a => /\.(js|jsx|ts|tsx|py|rb|java|cs|go|rs|c|cpp|swift|kt|php)$/i.test(a),
  )
  for (const artifact of codeArtifacts) {
    const cached = probeCache.get(artifact)
    if (!cached?.found) continue
    try {
      const content = await readArtifactContent(readFile, cached.resolvedPath, runCommand)
      if (typeof content === "string" && content.length > 0) {
        executedModalities.add("artifact-review")
        const placeholders = detectPlaceholderPatterns(content)
        if (placeholders.length > 0) {
          issues.push(`Placeholder/stub code in "${artifact}": ${placeholders.join("; ")}`)
        }
        const corruption = detectCodeCorruption(content)
        if (corruption.length > 0) {
          issues.push(`Corrupted/degenerated code in "${artifact}": ${corruption.join("; ")}`)
        }
        if (/\bclass\b/.test(content)) {
          const unresolvedMethods = detectUnresolvedMethods(content)
          if (unresolvedMethods.length > 0) {
            issues.push(`Missing method(s) in "${artifact}": ${unresolvedMethods.join("; ")}`)
          }
        }
        const unresolvedHelpers = detectUnresolvedBareHelpers(content)
        if (unresolvedHelpers.length > 0) {
          issues.push(`Missing helper dependency/dependencies in "${artifact}": ${unresolvedHelpers.join("; ")}`)
        }
        const useBeforeDeclaration = detectPotentialUseBeforeDeclaration(content)
        if (useBeforeDeclaration.length > 0) {
          issues.push(`Potential temporal-dead-zone/use-before-declaration issue in "${artifact}": ${useBeforeDeclaration.join("; ")}`)
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
          issues.push(`Potential 2D grid styling bug in "${artifact}": ${stripingIssues.join("; ")}`)
        }
      }
    } catch { /* already flagged */ }
  }

  // JavaScript syntax validation
  if (runCommand) {
    const jsArtifacts = sa.executionContext.targetArtifacts.filter(a => /\.js$/i.test(a))
    for (const artifact of jsArtifacts) {
      const cached = probeCache.get(artifact)
      if (!cached?.found) continue
      let checkPath = cached.resolvedPath
      const wsRoot = sa.executionContext.workspaceRoot || undefined
      if (!checkPath.startsWith("/") && wsRoot) {
        checkPath = wsRoot.endsWith("/") ? `${wsRoot}${checkPath}` : `${wsRoot}/${checkPath}`
      }
      try {
        const result = await executeToolForText(runCommand, {
          command: `node --check ${JSON.stringify(checkPath)} 2>&1`,
        })
        executedModalities.add("syntax")
        if (
          /SyntaxError|Unexpected token|Unexpected identifier/i.test(result) &&
          !/MODULE_NOT_FOUND|Cannot find module/i.test(result)
        ) {
          issues.push(`Syntax error in "${artifact}": ${result.trim().split("\n").slice(0, 3).join(" | ")}`)
        }
      } catch { /* non-critical */ }
    }
  }

  // HTML corruption detection
  const htmlArtifs = sa.executionContext.targetArtifacts.filter(a => /\.html?$/i.test(a))
  for (const artifact of htmlArtifs) {
    const cached = probeCache.get(artifact)
    if (!cached?.found) continue
    try {
      const content = await readArtifactContent(readFile, cached.resolvedPath, runCommand)
      if (typeof content === "string" && content.length > 0) {
        executedModalities.add("artifact-review")
        const htmlIssues = detectHtmlCorruption(content)
        if (htmlIssues.length > 0) {
          issues.push(`Corrupted HTML in "${artifact}": ${htmlIssues.join("; ")}`)
        }
      }
    } catch { /* already flagged */ }
  }
}

// ============================================================================
// Criteria proof sub-probe
// ============================================================================

export function probeCriteriaProof(
  sa: SubagentTaskStep,
  outputText: string,
  executedModalities: Set<string>,
  issues: string[],
): void {
  const runtimeCriterionRe = /\b(?:click|submit|drag|drop|keyboard|mouse|interactive|render|display|preview|execute|run|workflow|integration|e2e|end[- ]to[- ]end|api|request|response|endpoint|fetch|http|query|database|sql|persist|sync|auth|login)\b/i
  const complexRuleCriterionRe = /\b(?:all (?:rules?|cases?|scenarios?|constraints?|edge cases?)|full(?:y)? (?:implement|support|enforce|cover|valid|correct)|complete(?:ly)? (?:implement|correct|valid|enforce|cover)|every (?:rule|case|scenario|constraint|branch|path)|algorithmic contract|criterion[- ]by[- ]criterion|exhaustive(?:ly)?|provably correct|all (?:valid|invalid) (?:moves?|inputs?|states?|transitions?)|specification[- ]complete)\b/i
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

  {
    const complexCriteria = sa.acceptanceCriteria.filter(c => complexRuleCriterionRe.test(c))
    const blanketComplexClaim = /\b(?:all|fully|complete(?:ly)?|properly)\b.{0,80}\b(?:rules|logic|workflow|constraints|requirements)\b/i.test(outputText)
    const runtimeOnlyEvidence = executedModalities.has("runtime") && !executedModalities.has("tests")
    if (complexCriteria.length > 0 && runtimeOnlyEvidence && blanketComplexClaim) {
      issues.push(
        `CRITERIA PROOF MISSING: step claimed exhaustive rule/logic coverage from broad runtime evidence only (${complexCriteria.length} complex criteria). Require criterion-by-criterion evidence from code review or executable tests, not just a successful browser/render pass.`,
      )
    }
  }
}
