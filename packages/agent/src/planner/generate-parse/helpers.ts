import { EffectClass, StepRole, VerificationMode, isEffectClass, isStepRole, isVerificationMode } from "../../domain/index.js"
/**
 * Parse helpers and auto-fix normalizers for plan structures.
 *
 * @module
 */

import type { DeterministicToolStep, PlanEdge, PlanStep, SubagentTaskStep } from "../types.js"

// ============================================================================
// Parse helpers
// ============================================================================

export function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
}

/** Reject non-file-path entries that the LLM sometimes puts in targetArtifacts (CSS selectors, URLs, bare words). */
export function isValidArtifactPath(path: string): boolean {
  // CSS selectors: start with . or # and don't contain /
  if (/^[.#]/.test(path) && !path.includes("/")) return false
  // Must look like a file path (contain a dot with extension, or contain a /)
  if (!path.includes("/") && !path.includes(".")) return false
  return true
}

export function parseEffectClass(value: unknown): EffectClass {
  const s = String(value ?? "")
  if (isEffectClass(s)) {
    return s
  }
  return EffectClass.FilesystemWrite
}

export function parseVerificationMode(value: unknown): VerificationMode {
  const s = String(value ?? "")
  if (isVerificationMode(s)) {
    return s
  }
  return VerificationMode.None
}

export function parseStepRole(value: unknown): StepRole {
  const s = String(value ?? "")
  if (isStepRole(s)) {
    return s
  }
  return StepRole.Writer
}

export function parseArtifactRelations(value: unknown): Array<{ relationType: "read_dependency" | "write_owner"; artifactPath: string }> {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map(v => ({
      relationType: v.relationType === "write_owner" ? "write_owner" as const : "read_dependency" as const,
      artifactPath: String(v.artifactPath ?? ""),
    }))
    .filter(r => r.artifactPath.length > 0)
}

// ============================================================================
// Auto-fix: normalise artifact directory prefixes
// ============================================================================

export function normalizeArtifactDirectories(steps: PlanStep[]): void {
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const ctx = sa.executionContext
    if (!ctx?.targetArtifacts?.length) continue

    const newArtifacts = [...ctx.targetArtifacts]
    const newRelations = ctx.artifactRelations ? [...ctx.artifactRelations] : undefined
    let changed = false

    // Strategy 1: derive prefix from allowedWriteRoots
    let writePrefix: string | null = null
    if (ctx.allowedWriteRoots?.length) {
      const wsRoot = ctx.workspaceRoot.replace(/\/$/, "")
      for (const wr of ctx.allowedWriteRoots) {
        const norm = wr.replace(/\/$/, "")
        if (norm !== wsRoot && norm !== "." && norm !== "./" && norm.startsWith(wsRoot + "/")) {
          writePrefix = norm.slice(wsRoot.length + 1)
          break
        }
        if (!norm.startsWith("/") && norm !== "." && norm !== "./") {
          writePrefix = norm
          break
        }
      }
    }

    if (writePrefix) {
      for (let i = 0; i < newArtifacts.length; i++) {
        const art = newArtifacts[i]
        if (!art.includes("/")) {
          const prefixed = `${writePrefix}/${art}`
          newArtifacts[i] = prefixed
          changed = true
          if (newRelations) {
            for (let ri = 0; ri < newRelations.length; ri++) {
              if (newRelations[ri].artifactPath === art) {
                newRelations[ri] = { ...newRelations[ri], artifactPath: prefixed }
              }
            }
          }
        }
      }
    }

    // Strategy 2: scan objective text for "dir/filename" patterns
    if (!changed) {
      const textBlob = [
        sa.objective ?? "",
        ...(sa.acceptanceCriteria ?? []),
      ].join(" ")

      for (let i = 0; i < newArtifacts.length; i++) {
        const art = newArtifacts[i]
        if (art.includes("/")) continue
        const escaped = art.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const m = textBlob.match(new RegExp(`(\\b[\\w.-]+/)${escaped}\\b`))
        if (m) {
          const prefixed = m[1] + art
          newArtifacts[i] = prefixed
          changed = true
          if (newRelations) {
            for (let ri = 0; ri < newRelations.length; ri++) {
              if (newRelations[ri].artifactPath === art) {
                newRelations[ri] = { ...newRelations[ri], artifactPath: prefixed }
              }
            }
          }
        }
      }
    }

    if (changed) {
      const newCtx = {
        ...ctx,
        targetArtifacts: newArtifacts,
        ...(newRelations ? { artifactRelations: newRelations } : {}),
      }
      steps[si] = { ...sa, executionContext: newCtx } as SubagentTaskStep
    }
  }
}

// ============================================================================
// Auto-fix: deduplicate write ownership
// ============================================================================

export function deduplicateWriteOwnership(steps: PlanStep[]): void {
  const subagentSteps = steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  const ownersByArtifact = new Map<string, string[]>()
  for (const s of subagentSteps) {
    const relations = [
      ...(s.executionContext?.artifactRelations ?? []),
      ...(s.workflowStep?.artifactRelations ?? []),
    ]
    for (const rel of relations) {
      if (rel.relationType === "write_owner") {
        const list = ownersByArtifact.get(rel.artifactPath) ?? []
        if (!list.includes(s.name)) list.push(s.name)
        ownersByArtifact.set(rel.artifactPath, list)
      }
    }
  }

  for (const [artifact, owners] of ownersByArtifact) {
    if (owners.length <= 1) continue
    const downgradeSet = new Set(owners.slice(0, -1))

    for (const s of subagentSteps) {
      if (!downgradeSet.has(s.name)) continue
      const downgrade = (rels: readonly { relationType: string; artifactPath: string }[]) => {
        for (const rel of rels) {
          if (rel.artifactPath === artifact && rel.relationType === "write_owner") {
            ;(rel as { relationType: string }).relationType = "read_dependency"
          }
        }
      }
      if (s.executionContext?.artifactRelations) downgrade(s.executionContext.artifactRelations)
      if (s.workflowStep?.artifactRelations) downgrade(s.workflowStep.artifactRelations)
    }
  }
}

// ============================================================================
// Auto-fix: strip redundant verification deterministic_tool steps
// ============================================================================

export function stripRedundantVerificationSteps(steps: PlanStep[], edges: PlanEdge[]): void {
  const verifyToolNames = new Set(["browser_check"])
  const toRemove = new Set<string>()

  for (const step of steps) {
    if (step.stepType === "deterministic_tool") {
      const dt = step as DeterministicToolStep
      if (verifyToolNames.has(dt.tool)) {
        toRemove.add(step.name)
      }
    }
  }

  if (toRemove.size === 0) return

  for (let i = steps.length - 1; i >= 0; i--) {
    if (toRemove.has(steps[i].name)) {
      steps.splice(i, 1)
    }
  }

  for (let i = edges.length - 1; i >= 0; i--) {
    if (toRemove.has(edges[i].from) || toRemove.has(edges[i].to)) {
      edges.splice(i, 1)
    }
  }

  for (const step of steps) {
    if (step.dependsOn) {
      const filtered = step.dependsOn.filter(d => !toRemove.has(d))
      ;(step as unknown as { dependsOn: string[] }).dependsOn = filtered
    }
  }
}

// ============================================================================
// Auto-fix: verification coverage
// ============================================================================

export function ensureVerificationCoverage(steps: PlanStep[]): void {
  const subagentSteps = steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )
  if (subagentSteps.length <= 1) return

  const hasWriters = subagentSteps.some(
    s => s.executionContext?.effectClass !== "readonly",
  )
  const hasVerification = subagentSteps.some(
    s => s.executionContext?.verificationMode !== VerificationMode.None,
  )

  if (hasWriters && !hasVerification) {
    for (let i = subagentSteps.length - 1; i >= 0; i--) {
      const s = subagentSteps[i]
      if (s.executionContext && s.executionContext.effectClass !== "readonly") {
        const tools = s.requiredToolCapabilities ?? []
        const ctx = s.executionContext as { verificationMode: string }
        if (tools.includes("browser_check")) {
          ctx.verificationMode = VerificationMode.BrowserCheck
        } else if (tools.includes("run_command")) {
          ctx.verificationMode = VerificationMode.RunTests
        } else {
          ctx.verificationMode = VerificationMode.DeterministicFollowup
        }
        break
      }
    }
  }
}
