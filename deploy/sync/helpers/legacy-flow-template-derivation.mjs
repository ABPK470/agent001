export const DEFAULT_PIPELINE_IDS = [692, 780, 788, 791, 792, 798]

const METADATA_ONLY_FLOW_TEMPLATE = {
  label: "Metadata only",
  description: "Only apply metadata changes; do not trigger downstream deploy or refresh steps.",
  steps: [
    { id: "metadata-sync", phase: "metadata", kind: "metadataSync", title: "Metadata sync", description: "Apply transactional metadata changes for the selected entity scope." },
  ],
}

const ENTITY_HINTS_BY_ENTRY_SPROC = {
  "core.uspSyncContentObjectsTran": {
    entityId: "content",
    label: "Content dependencies",
    description: "Metadata sync followed by downstream dependency refresh for content entities.",
    metadataDescription: "Apply transactional metadata changes for the selected content scope.",
  },
  "core.uspSyncDataListObjectsTran": {
    entityId: "gateMetadata",
    label: "Gate refresh",
    description: "Metadata sync followed by gate metadata refresh and downstream pipeline start.",
    metadataDescription: "Apply transactional metadata changes for the selected gate metadata scope.",
  },
  "core.uspSyncCoreObjectsTran": {
    entityId: "contract",
    label: "Contract deploy",
    description: "Metadata sync plus full contract deployment, ETL, routines, and deploy stamps.",
    metadataDescription: "Apply transactional metadata changes for the selected contract scope.",
  },
  "core.uspSyncRuleObjectsTran": {
    entityId: "rule",
    label: "Rule deploy",
    description: "Metadata sync, dependent dataset deploy, rule deploy, and dependency refresh.",
    metadataDescription: "Apply transactional metadata changes for the selected rule scope.",
  },
  "core.uspSyncDatasetObjectsTran": {
    entityId: "dataset",
    label: "Dataset deploy",
    description: "Metadata sync followed by dataset deployment on the target ETL service.",
    metadataDescription: "Apply transactional metadata changes for the selected dataset scope.",
  },
  "core.uspSyncPipelineObjectsTran": {
    entityId: "pipelineActivity",
    label: "Pipeline register",
    description: "Metadata sync followed by registering the target pipeline with the agent service.",
    metadataDescription: "Apply transactional metadata changes for the selected pipeline activity scope.",
  },
}

export function parsePipelineIds(rawValue) {
  if (!rawValue || String(rawValue).trim() === "") {
    return [...DEFAULT_PIPELINE_IDS]
  }
  return String(rawValue)
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value))
}

export function buildFlowTemplateCatalogFromPipelines(pipelines) {
  const flowTemplates = Object.fromEntries(pipelines.map((pipeline) => {
    const hint = selectPipelineHint(pipeline)
    const steps = deriveFlowTemplateSteps(pipeline, hint)
    if (steps.length === 0) {
      throw new Error(`Pipeline ${pipeline.pipelineId} did not yield any flow-template steps.`)
    }
    return [hint.entityId, {
      label: hint.label,
      description: hint.description,
      steps,
    }]
  }))

  flowTemplates["metadata-only"] = {
    label: METADATA_ONLY_FLOW_TEMPLATE.label,
    description: METADATA_ONLY_FLOW_TEMPLATE.description,
    steps: METADATA_ONLY_FLOW_TEMPLATE.steps.map((step) => ({ ...step })),
  }

  return {
    version: 1,
    _comment: "Initial sync-definition flow templates. These seed DB-backed sync definition config rows and scaffolded repo drafts; after operators edit/save, DB becomes the source of truth.",
    flowTemplates,
  }
}

function selectPipelineHint(pipeline) {
  const entry = (pipeline.activities ?? []).find((activity) => typeof activity.storedProcedure === "string" && /^core\.uspSync.*ObjectsTran$/i.test(activity.storedProcedure))
  if (!entry?.storedProcedure) {
    throw new Error(`Pipeline ${pipeline.pipelineId} does not expose a legacy sync entry stored procedure.`)
  }
  const hint = ENTITY_HINTS_BY_ENTRY_SPROC[entry.storedProcedure]
  if (!hint) {
    throw new Error(`Unsupported legacy sync entry stored procedure ${entry.storedProcedure}.`)
  }
  return hint
}

function deriveFlowTemplateSteps(pipeline, hint) {
  return (pipeline.activities ?? [])
    .map((activity) => deriveStepFromActivity(activity, hint))
    .filter((step) => step !== null)
}

function deriveStepFromActivity(activity, hint) {
  const normalizedName = normalizeActivityName(activity.activityName)
  const entryProc = activity.storedProcedure

  if (entryProc && ENTITY_HINTS_BY_ENTRY_SPROC[entryProc]?.entityId === hint.entityId) {
    return { id: "metadata-sync", phase: "metadata", kind: "metadataSync", title: "Metadata sync", description: hint.metadataDescription }
  }

  if (hint.entityId === "content" && normalizedName === "handle dependencies") {
    return { id: "handle-dependencies", phase: "post-metadata", kind: "handleDependencies", title: "Handle dependencies", description: "Refresh downstream content dependency state.", objectName: "content" }
  }

  if (hint.entityId === "gateMetadata") {
    if (normalizedName === "metadata refresh") {
      return { id: "meta-refresh", phase: "post-metadata", kind: "metaRefresh", title: "Meta refresh", description: "Refresh target gate metadata." }
    }
    if (normalizedName === "remote content population") {
      return { id: "pipeline-start", phase: "post-metadata", kind: "pipelineStart", title: "Pipeline start", description: "Start the downstream gate refresh pipeline.", pipelineName: "All Lists content item population" }
    }
  }

  if (hint.entityId === "contract") {
    if (normalizedName === "to sync or not") {
      return { id: "audit-check", phase: "pre-transaction", kind: "auditCheck", title: "Audit check", description: "Validate target state before contract sync.", auditObjectType: "Contract" }
    }
    if (normalizedName === "lock contract for undeployment") {
      return { id: "target-lock", phase: "pre-transaction", kind: "targetLock", title: "Target lock", description: "Lock the target contract deployment window." }
    }
    if (normalizedName === "register remote pipeline") {
      return { id: "pipeline-register", phase: "post-metadata", kind: "pipelineRegister", title: "Pipeline register", description: "Register affected pipelines with the target agent service.", subjectRef: "contractPipelineId" }
    }
    if (normalizedName === "undeploy contract on target instance") {
      return { id: "contract-undeploy", phase: "post-metadata", kind: "contractUndeploy", title: "Contract undeploy", description: "Undeploy the target contract before redeployment." }
    }
    if (normalizedName === "unlock contract after undeployment") {
      return { id: "contract-unlock-after-undeploy", phase: "post-metadata", kind: "targetUnlock", title: "Unlock after undeploy", description: "Unlock the contract after undeploy." }
    }
    if (normalizedName === "to sync or not after undeployment") {
      return { id: "audit-check-2", phase: "post-metadata", kind: "auditCheck", title: "Pre-deploy audit check", description: "Run a second contract audit check before deployment.", auditObjectType: "Contract" }
    }
    if (normalizedName === "lock contract for deployment") {
      return { id: "contract-lock-for-deploy", phase: "post-metadata", kind: "targetLock", title: "Lock for deploy", description: "Lock the contract for deployment." }
    }
    if (normalizedName === "synchronize deploy pre script") {
      return { id: "contract-pre-script", phase: "post-metadata", kind: "contractPreScript", title: "Pre-deploy script", description: "Run contract pre-deployment scripts." }
    }
    if (normalizedName === "create stage dataset") {
      return { id: "contract-create-dataset-stage", phase: "post-metadata", kind: "contractCreateStageDataset", title: "Create stage dataset", description: "Create the stage dataset." }
    }
    if (normalizedName === "create archive dataset") {
      return { id: "contract-create-dataset-archive", phase: "post-metadata", kind: "contractCreateArchiveDataset", title: "Create archive dataset", description: "Create the archive dataset." }
    }
    if (normalizedName === "create list dataset") {
      return { id: "contract-create-dataset-list", phase: "post-metadata", kind: "contractCreateListDataset", title: "Create list dataset", description: "Create the list dataset." }
    }
    if (normalizedName === "create dim dataset") {
      return { id: "contract-create-dataset-dim", phase: "post-metadata", kind: "contractCreateDimDataset", title: "Create dim dataset", description: "Create the dimension dataset." }
    }
    if (normalizedName === "create fact dataset") {
      return { id: "contract-create-dataset-fact", phase: "post-metadata", kind: "contractCreateFactDataset", title: "Create fact dataset", description: "Create the fact dataset." }
    }
    if (normalizedName === "create foreign keys") {
      return { id: "contract-create-fks", phase: "post-metadata", kind: "contractCreateDatasetFks", title: "Create dataset FKs", description: "Reconcile contract dataset foreign keys." }
    }
    if (normalizedName === "synchronize deploy etl2 custom transformation") {
      return { id: "contract-deploy-etl", phase: "post-metadata", kind: "contractDeployEtl", title: "Deploy ETL", description: "Deploy ETL custom transformations." }
    }
    if (normalizedName === "synchronize deploy routine") {
      return { id: "contract-deploy-routine", phase: "post-metadata", kind: "contractDeployRoutine", title: "Deploy routines", description: "Deploy contract routines." }
    }
    if (normalizedName === "synchronize deploy post script") {
      return { id: "contract-post-script", phase: "post-metadata", kind: "contractPostScript", title: "Post-deploy script", description: "Run contract post-deployment scripts." }
    }
    if (normalizedName === "unlock contract after deployment") {
      return { id: "contract-unlock-after-deploy", phase: "post-metadata", kind: "targetUnlock", title: "Unlock after deploy", description: "Unlock the contract after deployment." }
    }
    if (normalizedName === "set sync date at source") {
      return { id: "set-sync-date", phase: "post-metadata", kind: "syncDate", title: "Sync date", description: "Stamp the contract sync date.", auditObjectType: "Contract" }
    }
    if (normalizedName === "update deploydate on sync target") {
      return { id: "set-deploy-date", phase: "post-metadata", kind: "deployDate", title: "Deploy date", description: "Stamp the contract deploy date.", auditObjectType: "Contract" }
    }
  }

  if (hint.entityId === "rule") {
    if (normalizedName === "create input dataset") {
      return { id: "dataset-deploy", phase: "post-metadata", kind: "datasetDeploy", title: "Dataset deploy", description: "Deploy datasets required by the rule on the target ETL service.", subjectRef: "ruleInputDatasetId" }
    }
    if (normalizedName === "deploy rules") {
      return { id: "rules-deploy", phase: "post-metadata", kind: "rulesDeploy", title: "Rules deploy", description: "Deploy the rule package on the target ETL service." }
    }
    if (normalizedName === "handle dependencies") {
      return { id: "handle-dependencies", phase: "post-metadata", kind: "handleDependencies", title: "Handle dependencies", description: "Refresh direct dependency state after rule deployment.", objectName: "rule" }
    }
    if (normalizedName === "update syncdate") {
      return { id: "sync-date", phase: "post-metadata", kind: "syncDate", title: "Sync date", description: "Stamp the rule sync date.", auditObjectType: "Rule" }
    }
    if (normalizedName === "update deploydate on sync target") {
      return { id: "deploy-date", phase: "post-metadata", kind: "deployDate", title: "Deploy date", description: "Stamp the rule deploy date.", auditObjectType: "Rule" }
    }
  }

  if (hint.entityId === "dataset") {
    if (normalizedName === "synchronize / create dataset objects") {
      return { id: "dataset-deploy", phase: "post-metadata", kind: "datasetDeploy", title: "Dataset deploy", description: "Deploy the dataset using the target ETL service." }
    }
    if (normalizedName === "update sync date") {
      return { id: "sync-date", phase: "post-metadata", kind: "syncDate", title: "Sync date", description: "Stamp the dataset sync date after deployment.", auditObjectType: "Dataset" }
    }
  }

  if (hint.entityId === "pipelineActivity" && normalizedName === "register remote pipeline") {
    return { id: "pipeline-register", phase: "post-metadata", kind: "pipelineRegister", title: "Pipeline register", description: "Register the target pipeline with the agent service." }
  }

  return null
}

function normalizeActivityName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
}