import { PolicyRole } from "@mia/agent"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { RunProfile, RunTaskType } from "../../../internal/enums/run-workspace.js"

export { RunTaskType }

/**
 * Run profile selects the safety/isolation model.
 *
 *  - RunProfile.Developer: legacy mode. Code-generation runs get an isolated copy of
 *    the source tree; analysis/chat runs execute against the shared source
 *    root. Suitable for trusted local developer use.
 *  - RunProfile.Hosted: every run executes inside an empty sandbox directory
 *    completely outside the application source tree. The agent has no
 *    visibility into the host workspace. This is the default for hosted
 *    deployments (Phase 1 of the hosted-MIA plan).
 */
export { RunProfile }

export type { RunWorkspaceContext, WorkspaceDiff } from "../../../ports/workspace.js"
import type { RunWorkspaceContext, WorkspaceDiff } from "../../../ports/workspace.js"

const CODEGEN_RE =
  /\b(?:build|create|implement|develop|write|code|scaffold|refactor|fix|patch|edit|modify|add|remove|rename|generate)\b/i

const COPY_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache"
])

const COPY_IGNORE_FILES = new Set([".DS_Store"])

const RUN_WORKSPACE_ROOT_NAME = "mia-runs"

export function getRunWorkspaceRoot(): string {
  return resolve(tmpdir(), RUN_WORKSPACE_ROOT_NAME)
}

function shouldIgnorePath(path: string): boolean {
  const segments = path.split("/")
  const base = segments[segments.length - 1] ?? ""
  if (COPY_IGNORE_FILES.has(base)) return true
  return segments.some((s) => COPY_IGNORE_DIRS.has(s))
}

export function classifyRunTaskType(goal: string): RunTaskType {
  return CODEGEN_RE.test(goal) ? RunTaskType.CodeGeneration : RunTaskType.AnalysisOrChat
}

/**
 * Resolve the active run profile from environment.
 * `AGENT_HOSTED_MODE=true` opts a deployment into hosted profile semantics
 * (always isolated, no source-tree copy, no shared-root execution).
 */
export function getRunProfile(): RunProfile {
  const flag = (process.env["AGENT_HOSTED_MODE"] ?? "").toLowerCase()
  return flag === "true" || flag === "1" || flag === "yes" ? RunProfile.Hosted : RunProfile.Developer
}

export function shouldUseIsolatedWorkspace(goal: string, resume: boolean): boolean {
  const isolationEnabled = process.env["AGENT_ISOLATED_WORKSPACE"] !== "false"
  if (!isolationEnabled || resume) return false
  if (getRunProfile() === RunProfile.Hosted) return true
  return classifyRunTaskType(goal) === RunTaskType.CodeGeneration
}

export async function prepareRunWorkspace(params: {
  runId: string
  sourceRoot: string
  goal: string
  resume: boolean
  profile?: RunProfile
  role?: PolicyRole
}): Promise<RunWorkspaceContext> {
  const sourceRoot = resolve(params.sourceRoot)
  const taskType = classifyRunTaskType(params.goal)

  // Role is the security gate, not the deployment env flag.
  //
  //   role=HostedUser → always isolated empty sandbox + Hosted profile,
  //                     regardless of AGENT_HOSTED_MODE. Non-admin users
  //                     never see the application source tree.
  //   role=Admin      → always execute against the real source tree with
  //                     Developer profile, even on hosted deployments.
  //                     Admins are deliberately never sandboxed so they
  //                     keep full operational access.
  //
  // `params.profile` and `getRunProfile()` are kept only to feed the
  // legacy code-gen isolation path (admin codegen runs still get a copy).
  const role = params.role ?? PolicyRole.Admin
  if (role === PolicyRole.HostedUser) {
    const sandboxRoot = resolve(getRunWorkspaceRoot(), `${params.runId}-${randomUUID().slice(0, 8)}`)
    await mkdir(sandboxRoot, { recursive: true })
    return {
      runId: params.runId,
      sourceRoot,
      executionRoot: sandboxRoot,
      taskType,
      isolated: true,
      profile: RunProfile.Hosted
    }
  }

  // Admin path: ignore AGENT_HOSTED_MODE entirely and treat the run as
  // Developer so the admin keeps direct access to the source tree.
  const profile = RunProfile.Developer

  if (!shouldUseIsolatedWorkspace(params.goal, params.resume)) {
    return {
      runId: params.runId,
      sourceRoot,
      executionRoot: sourceRoot,
      taskType,
      isolated: false,
      profile
    }
  }

  const sandboxRoot = resolve(getRunWorkspaceRoot(), `${params.runId}-${randomUUID().slice(0, 8)}`)
  await mkdir(sandboxRoot, { recursive: true })

  await cp(sourceRoot, sandboxRoot, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = relative(sourceRoot, src)
      if (!rel) return true
      return !shouldIgnorePath(rel.replace(/\\/g, "/"))
    }
  })

  return {
    runId: params.runId,
    sourceRoot,
    executionRoot: sandboxRoot,
    taskType,
    isolated: true,
    profile
  }
}

async function collectFileHashes(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      const rel = relative(root, fullPath).replace(/\\/g, "/")
      if (!rel) continue
      if (shouldIgnorePath(rel)) continue

      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue

      const content = await readFile(fullPath)
      const hash = createHash("sha256").update(content).digest("hex")
      result.set(rel, hash)
    }
  }

  await walk(root)
  return result
}

export async function computeWorkspaceDiff(
  sourceRoot: string,
  executionRoot: string
): Promise<WorkspaceDiff> {
  const sourceMap = await collectFileHashes(sourceRoot)
  const execMap = await collectFileHashes(executionRoot)

  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [path, execHash] of execMap) {
    const sourceHash = sourceMap.get(path)
    if (!sourceHash) {
      added.push(path)
    } else if (sourceHash !== execHash) {
      modified.push(path)
    }
  }

  for (const path of sourceMap.keys()) {
    if (!execMap.has(path)) deleted.push(path)
  }

  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort()
  }
}

export async function applyWorkspaceDiff(params: {
  sourceRoot: string
  executionRoot: string
  diff: WorkspaceDiff
}): Promise<{ added: number; modified: number; deleted: number }> {
  const { sourceRoot, executionRoot, diff } = params

  for (const relPath of [...diff.added, ...diff.modified]) {
    const from = join(executionRoot, relPath)
    const to = join(sourceRoot, relPath)
    await mkdir(dirname(to), { recursive: true })
    const content = await readFile(from)
    await writeFile(to, content)
  }

  for (const relPath of diff.deleted) {
    const target = join(sourceRoot, relPath)
    try {
      const info = await stat(target)
      if (info.isFile()) {
        await unlink(target)
      }
    } catch {
      // Ignore if file already removed.
    }
  }

  return {
    added: diff.added.length,
    modified: diff.modified.length,
    deleted: diff.deleted.length
  }
}

export async function cleanupRunWorkspace(context: RunWorkspaceContext): Promise<void> {
  if (!context.isolated) return
  await rm(context.executionRoot, { recursive: true, force: true })
}

export async function cleanupStaleRunWorkspaces(maxAgeMs: number): Promise<number> {
  const root = getRunWorkspaceRoot()
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const now = Date.now()
    let removed = 0

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = join(root, entry.name)
      const info = await stat(fullPath)
      if (now - info.mtimeMs <= maxAgeMs) continue
      await rm(fullPath, { recursive: true, force: true })
      removed += 1
    }

    return removed
  } catch {
    return 0
  }
}

export function summarizeWorkspaceDiff(diff: WorkspaceDiff): string {
  return JSON.stringify(
    {
      kind: "workspace_diff",
      added: diff.added,
      modified: diff.modified,
      deleted: diff.deleted,
      total: diff.added.length + diff.modified.length + diff.deleted.length
    },
    null,
    2
  )
}
