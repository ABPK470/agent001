/**
 * CSS / DOM / evidence helpers extracted from verifier-helpers.ts.
 *
 * @module
 */

import { uniqueStrings } from "../blueprint-contract/index.js"

// ============================================================================
// CSS helpers
// ============================================================================

export function extractDefinedCssClasses(css: string): string[] {
  const classes: string[] = []
  for (const match of css.matchAll(/\.([A-Za-z_-][\w-]*)\b/g)) {
    const cls = match[1]
    if (cls) classes.push(cls)
  }
  return uniqueStrings(classes)
}

export function extractReferencedCssClassesFromScript(code: string): string[] {
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

export function extractReferencedCssClassesFromHtml(html: string): string[] {
  const classes: string[] = []
  for (const match of html.matchAll(/\bclass\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    const raw = match[1] ?? ""
    for (const token of raw.split(/\s+/)) {
      if (/^[A-Za-z_-][\w-]*$/.test(token)) classes.push(token)
    }
  }
  return uniqueStrings(classes)
}

export function detectPotentialLinearGridStriping(css: string): string[] {
  const issues: string[] = []
  const hasGridColumns =
    /grid-template-columns\s*:\s*repeat\s*\(\s*([2-9]|\d{2,})\s*,/i.test(css) ||
    /grid-template-columns\s*:\s*(?:[^;]*\s){1,}[0-9.]+(?:fr|px|rem|em|%)\b/i.test(css)
  const usesFlatOddEven = /:nth-child\(odd\)/i.test(css) && /:nth-child\(even\)/i.test(css)
  const usesCoordinateAwareSelectors =
    /:nth-child\(\s*\d+n\s*[+-]\s*\d+\s*\)/i.test(css) ||
    /\[(?:data-|aria-)[^\]]*(?:row|col|x|y|cell)/i.test(css) ||
    /--(?:row|col|x|y)/i.test(css)

  if (hasGridColumns && usesFlatOddEven && !usesCoordinateAwareSelectors) {
    issues.push(
      "alternating cell styling appears to rely on flat :nth-child(odd/even) selectors inside a multi-column grid, which often produces striping instead of true 2D alternation"
    )
  }

  return issues
}

// ============================================================================
// Evidence & hallucination helpers
// ============================================================================

export function outputIntersectsArtifacts(outputLower: string, artifacts: readonly string[]): boolean {
  if (artifacts.length === 0) return true
  return artifacts.some((artifact) => {
    const normalizedArtifact = artifact.toLowerCase().replace(/^\.\//, "")
    const basename = normalizedArtifact.split("/").pop() ?? normalizedArtifact
    return outputLower.includes(basename) || outputLower.includes(normalizedArtifact)
  })
}

export function safeParseJson(text: string): Record<string, unknown> | null {
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

export function isBlockingCriteriaProofGap(issue: string): boolean {
  if (!issue.includes("CRITERIA PROOF MISSING")) return false
  return /shared-state contract requires/i.test(issue)
}
