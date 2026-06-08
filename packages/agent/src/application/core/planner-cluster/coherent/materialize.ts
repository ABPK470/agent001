/**
 * Coherent bundle materialization — write artifacts to the workspace and
 * read them back to confirm. Extracted from coherent.ts.
 *
 * @module
 */

import type { Tool, ToolResultEnvelope } from "../../types.js"
import type { CoherentSolutionBundle } from "../types.js"

export interface CoherentMaterializationResult {
  readonly writtenArtifacts: readonly string[]
  readonly readBackArtifacts: readonly string[]
  readonly diagnostics: readonly string[]
}

function normalizeToolResult(result: string | ToolResultEnvelope): { ok: boolean; summary: string } {
  if (typeof result === "string") {
    return {
      ok: !/^Error:/i.test(result),
      summary: result
    }
  }
  return {
    ok: result.ok !== false,
    summary: result.summary
  }
}

export async function materializeCoherentSolutionBundle(
  bundle: CoherentSolutionBundle,
  tools: {
    readonly writeFileTool?: Tool
    readonly readFileTool?: Tool
  }
): Promise<CoherentMaterializationResult> {
  const diagnostics: string[] = []
  const writtenArtifacts: string[] = []
  const readBackArtifacts: string[] = []

  if (!tools.writeFileTool) {
    return {
      writtenArtifacts,
      readBackArtifacts,
      diagnostics: ["write_file tool is unavailable for coherent bundle materialization."]
    }
  }

  for (const artifact of bundle.artifacts) {
    const writeResult = normalizeToolResult(
      await tools.writeFileTool.execute({
        path: artifact.path,
        content: artifact.content
      })
    )
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
    diagnostics
  }
}
