/**
 * Validate entity tip flowId against the live flow catalog (DB presets + shipped).
 */

import { hasSyncDefinitionFlowTemplate } from "@mia/sync"

import * as db from "../../../infra/persistence/sqlite.js"
import { loadAuthoringFlowCatalog } from "./definitions.js"

export function validateEntityFlowId(
  projectRoot: string,
  flowId: string,
  tenantId = "_default",
): string | null {
  const trimmed = flowId.trim()
  if (!trimmed) return "flowId is required"
  if (db.getSyncFlow(tenantId, trimmed)) return null
  const catalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  if (!hasSyncDefinitionFlowTemplate(catalog, trimmed)) {
    return `unknown flowId "${trimmed}"`
  }
  return null
}

/** @deprecated Use validateEntityFlowId */
export function validateEntityRunYaml(
  projectRoot: string,
  run: { template: string },
  tenantId = "_default",
): string | null {
  return validateEntityFlowId(projectRoot, run.template, tenantId)
}
