/**
 * Path canonicalization helpers for delegate tools.
 *
 * Ensures target artifacts and write paths are normalized consistently
 * across parent/child agent boundaries.
 *
 * @module
 */

import type { ExecutionEnvelope, SubagentTaskStep } from "../application/core/planner.js"
import type { Tool } from "../domain/agent-types.js"

const COMPLEX_IMPLEMENTATION_RE =
  /\b(?:game|rules?|engine|validator|workflow|state machine|parser|compiler|algorithm|reconciliation|move validation|checkmate|castling|en passant|promotion|scheduling|constraint|domain logic|business logic)\b/i

const DEFAULT_CHILD_ITERATIONS = 50
const MAX_CHILD_ITERATIONS = 180

interface CanonicalPathMap {
  readonly targets: readonly string[]
  readonly targetSet: ReadonlySet<string>
  readonly byBasename: ReadonlyMap<string, readonly string[]>
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export function normalizeRelativePath(path: string, workspaceRoot?: string): string {
  let p = path.replace(/\\/g, "/").trim()
  if (workspaceRoot) {
    const wsNorm = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")
    if (p.startsWith(`${wsNorm}/`)) {
      p = p.slice(wsNorm.length + 1)
    }
  }
  p = p.replace(/^\.\//, "").replace(/^\//, "")
  const segs = p.split("/").filter(Boolean)
  return segs.join("/")
}

function chooseCanonicalRoot(paths: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const slash = p.lastIndexOf("/")
    if (slash <= 0) continue
    const dir = p.slice(0, slash)
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = -1
  for (const [dir, count] of counts) {
    if (count > bestCount) {
      best = dir
      bestCount = count
    }
  }
  return best
}

export function canonicalizeArtifacts(artifacts: readonly string[], workspaceRoot?: string): string[] {
  const normalized = artifacts.map((a) => normalizeRelativePath(a, workspaceRoot)).filter(Boolean)
  if (normalized.length === 0) return []

  const canonicalRoot = chooseCanonicalRoot(normalized)
  if (!canonicalRoot) return [...new Set(normalized)]

  const canonical = normalized.map((p) => {
    if (p.includes("/")) return p
    return `${canonicalRoot}/${p}`
  })
  return [...new Set(canonical)]
}

function buildCanonicalPathMap(targetArtifacts: readonly string[], workspaceRoot?: string): CanonicalPathMap {
  const targets = canonicalizeArtifacts(targetArtifacts, workspaceRoot)
  const targetSet = new Set(targets)
  const byBasename = new Map<string, string[]>()
  for (const t of targets) {
    const base = t.split("/").pop() ?? t
    const arr = byBasename.get(base) ?? []
    arr.push(t)
    byBasename.set(base, arr)
  }
  return {
    targets,
    targetSet,
    byBasename
  }
}

function resolveWritePathToCanonical(
  rawPath: string,
  canonical: CanonicalPathMap,
  workspaceRoot?: string
): { ok: true; path: string; rewritten: boolean } | { ok: false; reason: string } {
  if (canonical.targets.length === 0) {
    const normalized = normalizeRelativePath(rawPath, workspaceRoot)
    return { ok: true, path: normalized || rawPath, rewritten: false }
  }

  const normalized = normalizeRelativePath(rawPath, workspaceRoot)
  if (!normalized) {
    return { ok: false, reason: "empty write path" }
  }

  if (canonical.targetSet.has(normalized)) {
    return { ok: true, path: normalized, rewritten: normalized !== rawPath }
  }

  const base = normalized.split("/").pop() ?? normalized
  const candidates = canonical.byBasename.get(base) ?? []
  if (candidates.length === 1 && candidates[0]) {
    return { ok: true, path: candidates[0], rewritten: candidates[0] !== rawPath }
  }

  return {
    ok: false,
    reason: `path "${rawPath}" is outside this step's targetArtifacts`
  }
}

export function wrapPlannerChildToolsForWriteScope(
  tools: readonly Tool[],
  envelope: ExecutionEnvelope
): Tool[] {
  const canonical = buildCanonicalPathMap(envelope.targetArtifacts, envelope.workspaceRoot)

  return tools.map((tool) => {
    if (tool.name !== "write_file" && tool.name !== "replace_in_file") {
      return tool
    }

    return {
      ...tool,
      async execute(args) {
        const rawPath = typeof args?.path === "string" ? args.path : ""
        if (!rawPath) {
          return "Error: WRITE SCOPE VIOLATION — missing path argument"
        }

        const resolved = resolveWritePathToCanonical(rawPath, canonical, envelope.workspaceRoot)
        if (!resolved.ok) {
          return (
            `Error: WRITE SCOPE VIOLATION — ${resolved.reason}. ` +
            `Allowed targetArtifacts for this step: ${canonical.targets.join(", ") || "(none declared)"}. ` +
            `Write was rejected before filesystem mutation.`
          )
        }

        const nextArgs = { ...(args as Record<string, unknown>), path: resolved.path }
        const result = await tool.execute(nextArgs)
        if (resolved.rewritten && typeof result === "string" && !result.startsWith("Error:")) {
          return `${result}\n[canonical-path] Rewrote write path "${rawPath}" -> "${resolved.path}"`
        }
        return result
      }
    }
  })
}

export function canonicalizeEnvelope(envelope: ExecutionEnvelope): ExecutionEnvelope {
  const targetArtifacts = canonicalizeArtifacts(envelope.targetArtifacts, envelope.workspaceRoot)
  const targetSet = new Set(targetArtifacts)
  const requiredSourceArtifacts = canonicalizeArtifacts(
    envelope.requiredSourceArtifacts,
    envelope.workspaceRoot
  ).map((src) => {
    if (targetSet.has(src)) return src
    const base = src.split("/").pop() ?? src
    const matches = targetArtifacts.filter((t) => t.endsWith(`/${base}`) || t === base)
    return matches.length === 1 ? matches[0] : src
  })

  return {
    ...envelope,
    targetArtifacts,
    requiredSourceArtifacts: [...new Set(requiredSourceArtifacts)],
    forbiddenArtifacts: [...new Set(envelope.forbiddenArtifacts ?? [])],
    requiredChecks: [...new Set(envelope.requiredChecks ?? [])],
    upstreamAcceptedArtifacts: [...new Set(envelope.upstreamAcceptedArtifacts ?? [])],
    unresolvedDependencyBlockers: [...new Set(envelope.unresolvedDependencyBlockers ?? [])],
    repairContext: envelope.repairContext
      ? {
          ...envelope.repairContext,
          requiredAcceptedArtifacts: [...new Set(envelope.repairContext.requiredAcceptedArtifacts)],
          unresolvedDependencyBlockers: [...new Set(envelope.repairContext.unresolvedDependencyBlockers)]
        }
      : undefined
  }
}

export interface PlannerChildBudgetMetrics {
  readonly hint: string
  readonly parsedHint: number
  readonly baseBudget: number
  readonly contractFloor: number
  readonly complexityBoost: number
  readonly computedMaxIterations: number
  readonly targetArtifactCount: number
  readonly requiredSourceArtifactCount: number
  readonly acceptanceCriteriaCount: number
  readonly codeArtifactCount: number
  readonly hasComplexImplementation: boolean
  readonly hasBlueprintSource: boolean
  readonly verificationMode: ExecutionEnvelope["verificationMode"]
}

export function computePlannerChildBudgetMetrics(
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope
): PlannerChildBudgetMetrics {
  const budgetMatch = step.maxBudgetHint.match(/(\d+)\s*iteration/i)
  const parsedBudget = budgetMatch ? parseInt(budgetMatch[1], 10) : DEFAULT_CHILD_ITERATIONS
  const baseBudget = Math.max(parsedBudget, DEFAULT_CHILD_ITERATIONS)
  const codeArtifactCount = envelope.targetArtifacts.filter((a) =>
    /\.(?:js|jsx|ts|tsx|py|rb|go|rs|java|php)$/i.test(a)
  ).length
  const isWriterStep = envelope.effectClass !== "readonly" && envelope.targetArtifacts.length > 0
  const combinedContractText = `${step.objective} ${step.acceptanceCriteria.join(" ")}`
  const hasComplexImplementation = COMPLEX_IMPLEMENTATION_RE.test(combinedContractText)
  const hasBlueprintSource = envelope.requiredSourceArtifacts.some((artifact) =>
    /(?:^|\/)BLUEPRINT\.md$/i.test(artifact)
  )

  const contractFloor = Math.min(
    60,
    Math.max(
      18,
      envelope.targetArtifacts.length * 2 +
        step.acceptanceCriteria.length * 3 +
        envelope.requiredSourceArtifacts.length +
        (envelope.verificationMode !== "none" ? 6 : 0) +
        (isWriterStep ? 8 : 0)
    )
  )

  const complexityBoost = isWriterStep
    ? Math.min(
        100,
        (step.acceptanceCriteria.length >= 8
          ? 34
          : step.acceptanceCriteria.length >= 6
            ? 24
            : step.acceptanceCriteria.length >= 4
              ? 12
              : 0) +
          (codeArtifactCount >= 4 ? 26 : codeArtifactCount >= 2 ? 16 : codeArtifactCount === 1 ? 8 : 0) +
          (envelope.requiredSourceArtifacts.length >= 4
            ? 16
            : envelope.requiredSourceArtifacts.length >= 2
              ? 8
              : envelope.requiredSourceArtifacts.length === 1
                ? 4
                : 0) +
          (envelope.verificationMode !== "none" ? 10 : 0) +
          (hasComplexImplementation ? 36 : 0) +
          (hasBlueprintSource ? 10 : 0)
      )
    : 0

  const adaptiveBudget = baseBudget + complexityBoost
  const computedMaxIterations = Math.min(
    Math.max(baseBudget, contractFloor, adaptiveBudget),
    MAX_CHILD_ITERATIONS
  )

  return {
    hint: step.maxBudgetHint,
    parsedHint: parsedBudget,
    baseBudget,
    contractFloor,
    complexityBoost,
    computedMaxIterations,
    targetArtifactCount: envelope.targetArtifacts.length,
    requiredSourceArtifactCount: envelope.requiredSourceArtifacts.length,
    acceptanceCriteriaCount: step.acceptanceCriteria.length,
    codeArtifactCount,
    hasComplexImplementation,
    hasBlueprintSource,
    verificationMode: envelope.verificationMode
  }
}

export function computePlannerChildMaxIterations(
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope
): number {
  return computePlannerChildBudgetMetrics(step, envelope).computedMaxIterations
}
