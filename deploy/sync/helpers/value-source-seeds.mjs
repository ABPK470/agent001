/**
 * Ground-truth value source catalog seeds — shipped in sync-metadata.json and seeded to SQLite.
 *
 * Single authority for built-in wiring; operators may edit labels/descriptions in DB.
 * Re-deploy refreshes built_in rows from this artifact (same pattern as flows/actions).
 */

export const VALUE_SOURCE_SEEDS = [
  {
    id: "planEntityId",
    label: "Plan entity id",
    definition: {
      description:
        "Numeric id of the entity being synced (contractId, datasetId, ruleId, …). Same for every step in the run.",
      resolver: { kind: "planEntityId" },
    },
  },
  {
    id: "planActor",
    label: "Plan actor (UPN)",
    definition: {
      description: "UPN of the user who started the sync run.",
      resolver: { kind: "planActor" },
    },
  },
  {
    id: "currentStepId",
    label: "Current step id",
    definition: {
      description: "Flow step id (step.id) of the step currently executing.",
      resolver: { kind: "currentStepId" },
    },
  },
  {
    id: "contractName",
    label: "Contract name",
    definition: {
      description:
        "Contract name on target after metadata sync (core.Contract.name for plan entity id).",
      resolver: {
        kind: "targetSql",
        query: "SELECT [name] AS name FROM core.Contract WHERE contractId = @entityId",
        resultColumn: "name",
        resultType: "string",
      },
    },
  },
  {
    id: "ruleInputDatasetId",
    label: "Rule input dataset id",
    definition: {
      description: "Target SQL: inputDatasetId from core.Rule for the synced rule.",
      resolver: {
        kind: "targetSql",
        query: "SELECT inputDatasetId FROM core.[Rule] WHERE ruleId = @entityId",
        resultColumn: "inputDatasetId",
        resultType: "number",
      },
    },
  },
  {
    id: "contractPipelineId",
    label: "Contract pipeline id",
    definition: {
      description: "Target SQL: pipelineId from core.Pipeline for the synced contract.",
      resolver: {
        kind: "targetSql",
        query: "SELECT pipelineId FROM core.Pipeline WHERE contractId = @entityId",
        resultColumn: "pipelineId",
        resultType: "number",
      },
    },
  },
  {
    id: "objectName",
    label: "Object name",
    definition: {
      description: "Dependency object name string (e.g. content, rule). Typed on each flow step.",
      resolver: { kind: "stepField", field: "objectName" },
    },
  },
  {
    id: "auditObjectType",
    label: "Audit object type",
    definition: {
      description:
        "Contract / Dataset / Rule label for audit gate procedures (@objType). Typed on each flow step.",
      resolver: { kind: "stepField", field: "auditObjectType" },
    },
  },
  {
    id: "pipelineName",
    label: "Pipeline name",
    definition: {
      description: "Agent pipeline display name (not pipeline id). Typed on each flow step.",
      resolver: { kind: "stepField", field: "pipelineName" },
    },
  },
]

/** @deprecated Use VALUE_SOURCE_SEEDS — SQL literals kept for generator tests only */
export const BUILTIN_TARGET_SQL = {
  contractName: VALUE_SOURCE_SEEDS.find((s) => s.id === "contractName").definition.resolver,
  ruleInputDatasetId: VALUE_SOURCE_SEEDS.find((s) => s.id === "ruleInputDatasetId").definition.resolver,
  contractPipelineId: VALUE_SOURCE_SEEDS.find((s) => s.id === "contractPipelineId").definition.resolver,
}
