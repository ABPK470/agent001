/**
 * Validate entity tip flowId against the live flow catalog (DB presets + shipped).
 */

import { hasSyncDefinitionFlowTemplate } from "@mia/sync"

import * as db from "../../../infra/persistence/sqlite.js"
import { loadAuthoringFlowCatalog } from "./definitions.js"

export async function validateEntityFlowId(
  projectRoot: string,
  flowId: string,
  tenantId = "_default",
): Promise<string | null> {
  const trimmed = flowId.trim()
  if (!trimmed) return "flowId is required"
  if (await db.getSyncFlow(tenantId, trimmed)) return null
  const catalog = await loadAuthoringFlowCatalog(projectRoot, tenantId)
  if (!hasSyncDefinitionFlowTemplate(catalog, trimmed)) {
    return `unknown flowId "${trimmed}"`
  }
  return null
}

/** @deprecated Use validateEntityFlowId */
export async function validateEntityRunYaml(
  projectRoot: string,
  run: { template: string },
  tenantId = "_default",
): Promise<string | null> {
  return await validateEntityFlowId(projectRoot, run.template, tenantId)
}
