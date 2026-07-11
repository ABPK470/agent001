/**
 * Legacy flow step kind ids (kebab-case) → canonical camelCase catalog ids.
 */

import type { AuthoredSyncFlowStep } from "@mia/shared-types"

const LEGACY_KEBAB_FLOW_KIND_IDS: Record<string, string> = {
  "metadata-sync": "metadataSync",
  "audit-check": "auditCheck",
  "target-lock": "targetLock",
  "target-unlock": "targetUnlock",
  "contract-undeploy": "contractUndeploy",
  "contract-pre-script": "contractPreScript",
  "contract-create-stage-dataset": "contractCreateStageDataset",
  "contract-create-archive-dataset": "contractCreateArchiveDataset",
  "contract-create-list-dataset": "contractCreateListDataset",
  "contract-create-dim-dataset": "contractCreateDimDataset",
  "contract-create-fact-dataset": "contractCreateFactDataset",
  "contract-create-dataset-fks": "contractCreateDatasetFks",
  "contract-deploy-etl": "contractDeployEtl",
  "contract-deploy-routine": "contractDeployRoutine",
  "contract-post-script": "contractPostScript",
  "dataset-deploy": "datasetDeploy",
  "rules-deploy": "rulesDeploy",
  "pipeline-register": "pipelineRegister",
  "meta-refresh": "metaRefresh",
  "pipeline-start": "pipelineStart",
  "handle-dependencies": "handleDependencies",
  "sync-date": "syncDate",
  "deploy-date": "deployDate",
}

export function canonicalizeFlowStepKind(kind: string): string {
  return LEGACY_KEBAB_FLOW_KIND_IDS[kind] ?? kind
}

export function normalizeFlowStepKinds(steps: AuthoredSyncFlowStep[]): AuthoredSyncFlowStep[] {
  return steps.map((step) => ({
    ...step,
    kind: canonicalizeFlowStepKind(step.kind),
  }))
}
