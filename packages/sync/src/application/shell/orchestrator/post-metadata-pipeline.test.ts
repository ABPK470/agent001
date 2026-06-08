import type { ConnectionPool } from "mssql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PostMetadataActionKind } from "../../../domain/enums.js"
import { createPublishedSyncDefinitionRegistry } from "../../../domain/published-definition-registry.js"
import type { SyncRuntimeHost } from "../../../ports/host.js"
import type { SyncExecutionContractStep, SyncPlan } from "../plan-store.js"
import {
    createDataset,
    createDatasetFKs,
    deployETL,
    deployRoutine,
    resolveContractName,
    runAuditCheckDirect,
    runContractDeploymentScriptsDirect,
    setContractLockDirect,
    undeployMarkedContract,
} from "./contract-deploy.js"
import { trackedExecute, trackedQuery } from "./db-helpers.js"
import { runPostMetadataPipeline } from "./post-metadata-pipeline.js"

vi.mock("./db-helpers.js", () => ({
  trackedExecute: vi.fn(),
  trackedQuery: vi.fn(),
}))

vi.mock("./contract-deploy.js", () => ({
  createDataset: vi.fn(),
  createDatasetFKs: vi.fn(),
  deployETL: vi.fn(),
  deployRoutine: vi.fn(),
  resolveContractName: vi.fn(),
  runAuditCheckDirect: vi.fn(),
  runContractDeploymentScriptsDirect: vi.fn(),
  setContractLockDirect: vi.fn(),
  undeployMarkedContract: vi.fn(),
}))

describe("runPostMetadataPipeline", () => {
  const trackedQueryMock = vi.mocked(trackedQuery)
  const trackedExecuteMock = vi.mocked(trackedExecute)
  const createDatasetMock = vi.mocked(createDataset)
  const createDatasetFKsMock = vi.mocked(createDatasetFKs)
  const deployETLMock = vi.mocked(deployETL)
  const deployRoutineMock = vi.mocked(deployRoutine)
  const resolveContractNameMock = vi.mocked(resolveContractName)
  const runAuditCheckDirectMock = vi.mocked(runAuditCheckDirect)
  const runContractDeploymentScriptsDirectMock = vi.mocked(runContractDeploymentScriptsDirect)
  const setContractLockDirectMock = vi.mocked(setContractLockDirect)
  const undeployMarkedContractMock = vi.mocked(undeployMarkedContract)
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    createDatasetMock.mockResolvedValue({} as never)
    createDatasetFKsMock.mockResolvedValue({} as never)
    deployETLMock.mockResolvedValue({} as never)
    deployRoutineMock.mockResolvedValue({} as never)
    resolveContractNameMock.mockResolvedValue("AccountClientMapping")
    trackedExecuteMock.mockResolvedValue({} as never)
    trackedQueryMock.mockResolvedValue({ recordset: [] } as never)
    runAuditCheckDirectMock.mockResolvedValue({} as never)
    runContractDeploymentScriptsDirectMock.mockResolvedValue({} as never)
    setContractLockDirectMock.mockResolvedValue({} as never)
    undeployMarkedContractMock.mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("deploys dataset then stamps sync date", async () => {
    const progress = await runForEntity("dataset", 792, [
      PostMetadataActionKind.DatasetDeploy,
      PostMetadataActionKind.SyncDate,
    ])

    expect(stepNames(progress)).toEqual(["dataset-deploy", "set-sync-date"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://etl.example/dataset/deploy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ datasetId: 792, userFullName: "user@example.com" }),
      }),
    )
    expect(runAuditCheckDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "syncDate", id: 792, objType: "Dataset" }),
      "DEV",
      undefined,
      undefined,
    )
  })

  it("runs rule sequence in legacy order", async () => {
    trackedQueryMock.mockResolvedValueOnce({ recordset: [{ inputDatasetId: 444 }] } as never)
    const progress = await runForEntity("rule", 791, [
      PostMetadataActionKind.DatasetDeploy,
      PostMetadataActionKind.RulesDeploy,
      PostMetadataActionKind.HandleDependencies,
      PostMetadataActionKind.SyncDate,
      PostMetadataActionKind.DeployDate,
    ])

    expect(stepNames(progress)).toEqual([
      "dataset-deploy",
      "rules-deploy",
      "handle-dependencies",
      "set-sync-date",
      "set-deploy-date",
    ])
    expect(trackedQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "SELECT inputDatasetId FROM core.[Rule] WHERE ruleId = @ruleId",
      "postMetadata.resolveRuleInputDatasetId(791)",
      "UAT",
      undefined,
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://etl.example/dataset/deploy",
      expect.objectContaining({
        body: JSON.stringify({ datasetId: 444, userFullName: "user@example.com" }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://etl.example/rules/deploy",
      expect.objectContaining({
        body: JSON.stringify({ ruleId: 791, userFullName: "user@example.com" }),
      }),
    )
    expect(trackedExecuteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "core.uspObjectDependencies",
      "postMetadata.handleDependencies(rule/791)",
      "UAT",
      undefined,
    )
    expect(runAuditCheckDirectMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "syncDate", id: 791, objType: "Rule" }),
      "DEV",
      undefined,
      undefined,
    )
    expect(runAuditCheckDirectMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "deployDate", id: 791, objType: "Rule" }),
      "UAT",
      undefined,
      undefined,
    )
  })

  it("registers pipeline activity on Agent", async () => {
    const progress = await runForEntity("pipelineActivity", 798, [
      PostMetadataActionKind.PipelineRegister,
    ])

    expect(stepNames(progress)).toEqual(["pipeline-register"])
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/pipeline/register",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ pipelineId: 798 }),
      }),
    )
  })

  it("refreshes gate metadata then starts the list population pipeline", async () => {
    const progress = await runForEntity("gateMetadata", 780, [
      PostMetadataActionKind.MetaRefresh,
      PostMetadataActionKind.PipelineStart,
    ])

    expect(stepNames(progress)).toEqual(["meta-refresh", "pipeline-start"])
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://gate.example/api/meta/refresh",
      expect.objectContaining({ method: "GET" }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://agent.example/pipeline/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "All Lists content item population" }),
      }),
    )
  })

  it("handles content dependencies explicitly", async () => {
    const progress = await runForEntity("content", 692, [
      PostMetadataActionKind.HandleDependencies,
    ])
    const request = trackedExecuteMock.mock.calls[0]?.[1] as unknown as {
      input: { mock: { calls: Array<[string, unknown, unknown]> } }
    }

    expect(stepNames(progress)).toEqual(["handle-dependencies"])
    expect(trackedExecuteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "core.uspObjectDependencies",
      "postMetadata.handleDependencies(content/692)",
      "UAT",
      undefined,
    )
    expect(request.input.mock.calls.map(([name, , value]) => [name, value])).toEqual([
      ["id", "692"],
      ["objectName", "content"],
    ])
  })

  it("runs the expanded explicit contract flow after metadata", async () => {
    trackedQueryMock.mockResolvedValueOnce({ recordset: [{ pipelineId: 3525 }] } as never)
    const { progress } = await runScenario({
      entityType: "contract",
      entityId: 788,
      steps: contractSteps(),
    })

    expect(stepNames(progress)).toEqual([
      "pipeline-register",
      "contract-undeploy",
      "contract-unlock-after-undeploy",
      "audit-check-2",
      "contract-lock-for-deploy",
      "contract-pre-script",
      "contract-create-dataset-stage",
      "contract-create-dataset-archive",
      "contract-create-dataset-list",
      "contract-create-dataset-dim",
      "contract-create-dataset-fact",
      "contract-create-fks",
      "contract-deploy-etl",
      "contract-deploy-routine",
      "contract-post-script",
      "contract-unlock-after-deploy",
      "set-sync-date",
      "set-deploy-date",
    ])
    expect(trackedQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "SELECT pipelineId FROM core.Pipeline WHERE contractId = @contractId",
      "postMetadata.resolveContractPipelineId(788)",
      "UAT",
      undefined,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/pipeline/register",
      expect.objectContaining({ body: JSON.stringify({ pipelineId: 3525 }) }),
    )
    expect(resolveContractNameMock).toHaveBeenCalledOnce()
    expect(undeployMarkedContractMock).toHaveBeenCalledOnce()
    expect(setContractLockDirectMock).toHaveBeenCalledTimes(3)
    expect(createDatasetMock).toHaveBeenCalledTimes(5)
    expect(createDatasetFKsMock).toHaveBeenCalledOnce()
    expect(deployETLMock).toHaveBeenCalledOnce()
    expect(deployRoutineMock).toHaveBeenCalledOnce()
    expect(runContractDeploymentScriptsDirectMock).toHaveBeenCalledTimes(2)
  })

  it("records a failed step and continues to later actions", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))
    const { progress, result } = await runScenario({
      entityType: "dataset",
      entityId: 792,
      actions: [
        PostMetadataActionKind.DatasetDeploy,
        PostMetadataActionKind.SyncDate,
      ],
    })

    expect(stepNames(progress)).toEqual(["dataset-deploy", "dataset-deploy", "set-sync-date"])
    expect(progress[1]).toMatchObject({ step: "dataset-deploy", error: expect.stringContaining("500") })
    expect(result.stepWarnings).toEqual([
      expect.objectContaining({ step: "dataset-deploy", sproc: "direct" }),
    ])
    expect(runAuditCheckDirectMock).toHaveBeenCalledOnce()
  })
})

async function runForEntity(
  entityType: string,
  entityId: string | number,
  actions: PostMetadataActionKind[],
) {
  const { progress } = await runScenario({ entityType, entityId, actions })
  return progress
}

async function runScenario(input: {
  entityType: string
  entityId: string | number
  actions?: PostMetadataActionKind[]
  steps?: SyncExecutionContractStep[]
}) {
  const progress: Array<Record<string, unknown>> = []
  const host = createHost()
  const steps = input.steps ?? createSteps(input.entityType, input.actions ?? [])

  const result = await runPostMetadataPipeline({
    host,
    srcPool: createPool(),
    tgtPool: createPool(),
    plan: createPlan(input.entityType, input.actions ?? []),
    planId: "plan-1",
    entityId: input.entityId,
    entityType: input.entityType,
    steps,
    onProgress: (entry) => progress.push(entry as unknown as Record<string, unknown>),
    userUpn: "user@example.com",
  })

  return { progress, result }
}

function contractSteps(): SyncExecutionContractStep[] {
  return [
    { id: "pipeline-register", phase: "post-metadata", kind: "pipelineRegister", title: "Pipeline register", description: "Register affected pipelines with the target agent service.", subjectRef: "contractPipelineId" },
    { id: "contract-undeploy", phase: "post-metadata", kind: "contractUndeploy", title: "Contract undeploy", description: "Undeploy the target contract before redeployment." },
    { id: "contract-unlock-after-undeploy", phase: "post-metadata", kind: "targetUnlock", title: "Unlock after undeploy", description: "Unlock the contract after undeploy." },
    { id: "audit-check-2", phase: "post-metadata", kind: "auditCheck", title: "Pre-deploy audit check", description: "Run a second contract audit check before deployment.", auditObjectType: "Contract" },
    { id: "contract-lock-for-deploy", phase: "post-metadata", kind: "targetLock", title: "Lock for deploy", description: "Lock the contract for deployment." },
    { id: "contract-pre-script", phase: "post-metadata", kind: "contractPreScript", title: "Pre-deploy script", description: "Run contract pre-deployment scripts." },
    { id: "contract-create-dataset-stage", phase: "post-metadata", kind: "contractCreateStageDataset", title: "Create stage dataset", description: "Create the stage dataset." },
    { id: "contract-create-dataset-archive", phase: "post-metadata", kind: "contractCreateArchiveDataset", title: "Create archive dataset", description: "Create the archive dataset." },
    { id: "contract-create-dataset-list", phase: "post-metadata", kind: "contractCreateListDataset", title: "Create list dataset", description: "Create the list dataset." },
    { id: "contract-create-dataset-dim", phase: "post-metadata", kind: "contractCreateDimDataset", title: "Create dim dataset", description: "Create the dimension dataset." },
    { id: "contract-create-dataset-fact", phase: "post-metadata", kind: "contractCreateFactDataset", title: "Create fact dataset", description: "Create the fact dataset." },
    { id: "contract-create-fks", phase: "post-metadata", kind: "contractCreateDatasetFks", title: "Create dataset FKs", description: "Reconcile contract dataset foreign keys." },
    { id: "contract-deploy-etl", phase: "post-metadata", kind: "contractDeployEtl", title: "Deploy ETL", description: "Deploy ETL custom transformations." },
    { id: "contract-deploy-routine", phase: "post-metadata", kind: "contractDeployRoutine", title: "Deploy routines", description: "Deploy contract routines." },
    { id: "contract-post-script", phase: "post-metadata", kind: "contractPostScript", title: "Post-deploy script", description: "Run contract post-deployment scripts." },
    { id: "contract-unlock-after-deploy", phase: "post-metadata", kind: "targetUnlock", title: "Unlock after deploy", description: "Unlock the contract after deployment." },
    { id: "set-sync-date", phase: "post-metadata", kind: "syncDate", title: "Sync date", description: "Stamp the contract sync date.", auditObjectType: "Contract" },
    { id: "set-deploy-date", phase: "post-metadata", kind: "deployDate", title: "Deploy date", description: "Stamp the contract deploy date.", auditObjectType: "Contract" },
  ]
}

function stepNames(progress: Array<Record<string, unknown>>): string[] {
  return progress
    .map((entry) => entry.step)
    .filter((step): step is string => typeof step === "string")
}

function createPlan(entityType: string, actions: PostMetadataActionKind[]): SyncPlan {
  return {
    planId: "plan-1",
    createdAt: new Date(0).toISOString(),
    createdAtMs: 0,
    entity: { type: entityType as never, id: 1, displayName: entityType },
    source: "DEV",
    target: "UAT",
    preflight: { catalogCompatible: true, issues: [] },
    tables: [],
    totals: { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0, tablesCount: 0 },
    dependencyGraph: { nodes: [], edges: [] },
    warnings: [],
    estimatedDurationSec: 0,
    recipeSnapshot: {
      entityType: entityType as never,
      tables: [],
      executionOrder: [],
      reverseOrder: [],
    },
  }
}

function createSteps(entityType: string, actions: PostMetadataActionKind[]): SyncExecutionContractStep[] {
  return actions.map((kind, index) => ({
    id: stepId(kind),
    phase: "post-metadata",
    kind,
    title: kind,
    description: kind,
    subjectRef: kind === PostMetadataActionKind.DatasetDeploy && entityType === "rule"
      ? "ruleInputDatasetId"
      : kind === PostMetadataActionKind.PipelineRegister && entityType === "contract"
        ? "contractPipelineId"
        : "entityId",
    objectName: kind === PostMetadataActionKind.HandleDependencies ? entityType.toLowerCase() : null,
    auditObjectType: kind === PostMetadataActionKind.SyncDate || kind === PostMetadataActionKind.DeployDate
      ? ({ dataset: "Dataset", rule: "Rule", content: "Content", pipelineActivity: "Pipeline", gateMetadata: "MetaTable", contract: "Contract" }[entityType] ?? entityType)
      : null,
    pipelineName: kind === PostMetadataActionKind.PipelineStart ? "All Lists content item population" : null,
  }))
}

function stepId(kind: PostMetadataActionKind): string {
  switch (kind) {
    case PostMetadataActionKind.DatasetDeploy:
      return "dataset-deploy"
    case PostMetadataActionKind.RulesDeploy:
      return "rules-deploy"
    case PostMetadataActionKind.PipelineRegister:
      return "pipeline-register"
    case PostMetadataActionKind.MetaRefresh:
      return "meta-refresh"
    case PostMetadataActionKind.PipelineStart:
      return "pipeline-start"
    case PostMetadataActionKind.HandleDependencies:
      return "handle-dependencies"
    case PostMetadataActionKind.SyncDate:
      return "set-sync-date"
    case PostMetadataActionKind.DeployDate:
      return "set-deploy-date"
    default:
      return String(kind)
  }
}

function createHost(): SyncRuntimeHost {
  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: null },
    },
    sync: {
      eventSink: vi.fn(),
      runSink: {
        start: vi.fn(),
        finish: vi.fn(),
      },
      publishedDefinitions: createPublishedSyncDefinitionRegistry(),
      environments: new Map([
        ["DEV", {
          name: "DEV",
          displayName: "DEV",
          color: "blue",
          role: "both",
          ringOrder: 0,
          agentServiceBaseUrl: "https://agent.example",
          etlServiceBaseUrl: "https://etl.example",
          gateServiceBaseUrl: "https://gate.example",
          syncAllowlist: [],
          allowedSyncTargets: null,
          defaultAccessMode: "read_write",
          allowedOperations: ["query_read", "schema_introspect", "sync_preview", "sync_execute", "dml"],
          denyDml: false,
          denyDdl: false,
          approvalRequiredOperations: ["sync_execute"],
        }],
        ["UAT", {
          name: "UAT",
          displayName: "UAT",
          color: "amber",
          role: "both",
          ringOrder: 1,
          agentServiceBaseUrl: "https://agent.example",
          etlServiceBaseUrl: "https://etl.example",
          gateServiceBaseUrl: "https://gate.example",
          syncAllowlist: [],
          allowedSyncTargets: null,
          defaultAccessMode: "read_only",
          allowedOperations: ["query_read", "schema_introspect", "sync_preview"],
          denyDml: true,
          denyDdl: true,
          approvalRequiredOperations: ["sync_execute"],
        }],
      ]),
      plans: { diskRoot: null, memCache: new Map() },
      dbProjectRoot: null,
    },
  }
}

function createPool(): ConnectionPool {
  return {
    request: () => {
      const request = {
        input: vi.fn(),
      }
      request.input.mockReturnValue(request)
      return request
    },
  } as unknown as ConnectionPool
}