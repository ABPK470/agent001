import type { ConnectionPool } from "mssql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PostMetadataActionKind } from "../../domain/enums.js"
import { loadDeployFlowCatalogForTests } from "../../test-support/test-flow-catalog.js"
import { createPublishedSyncDefinitionRegistry } from "../published-definition-registry.js"
import { ALWAYS_PUBLISH_READY } from "../../domain/publish-readiness.js"
import type { SyncRuntimeHost } from "../../ports/host.js"
import type { SyncExecutionContractStep, SyncPlan } from "../plan-store.js"
import { asPlanId } from "../../domain/types/branded-ids.js"
import { trackedExecute, trackedQuery } from "./db-helpers.js"
import { runPostMetadataPipeline } from "./post-metadata-pipeline.js"

vi.mock("./db-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db-helpers.js")>()
  return {
    ...actual,
    trackedExecute: vi.fn(),
    trackedQuery: vi.fn(),
  }
})

describe("runPostMetadataPipeline", () => {
  const trackedQueryMock = vi.mocked(trackedQuery)
  const trackedExecuteMock = vi.mocked(trackedExecute)
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    trackedExecuteMock.mockResolvedValue({ recordsets: [[{ status: "success", message: "ok" }]] } as never)
    trackedQueryMock.mockImplementation(async (_host, _conn, sql: string) => {
      if (sql.includes("core.Contract")) {
        return { recordset: [{ name: "AccountClientMapping" }] } as never
      }
      if (sql.includes("core.Pipeline")) {
        return { recordset: [{ pipelineId: 3525 }] } as never
      }
      if (sql.includes("core.[Rule]")) {
        return { recordset: [{ inputDatasetId: 444 }] } as never
      }
      return { recordset: [] } as never
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("deploys dataset then stamps sync date", async () => {
    const progress = await runForEntity("dataset", 792, [
      PostMetadataActionKind.DatasetDeploy,
      PostMetadataActionKind.SyncDate
    ])

    expect(stepNames(progress)).toEqual(["datasetDeploy", "setSyncDate"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://etl.example/dataset/deploy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ datasetId: 792, userFullName: "user@example.com" })
      })
    )
    expectAuditProcedure(1, "DEV", { action: "syncDate", id: 792, objType: "Dataset" })
  })

  it("runs rule sequence in legacy order", async () => {
    const progress = await runForEntity("rule", 791, [
      PostMetadataActionKind.DatasetDeploy,
      PostMetadataActionKind.RulesDeploy,
      PostMetadataActionKind.HandleDependencies,
      PostMetadataActionKind.SyncDate,
      PostMetadataActionKind.DeployDate
    ])

    expect(stepNames(progress)).toEqual([
      "datasetDeploy",
      "rulesDeploy",
      "handleDependencies",
      "setSyncDate",
      "setDeployDate"
    ])
    expect(trackedQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      "UAT",
      "SELECT inputDatasetId FROM core.[Rule] WHERE ruleId = @entityId",
      "targetSql.inputDatasetId(791)",
      undefined,
      expect.anything()
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://etl.example/dataset/deploy",
      expect.objectContaining({
        body: JSON.stringify({ datasetId: 444, userFullName: "user@example.com" })
      })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://etl.example/rules/deploy",
      expect.objectContaining({
        body: JSON.stringify({ ruleId: 791, userFullName: "user@example.com" })
      })
    )
    expect(trackedExecuteMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "UAT",
      "core.uspObjectDependencies",
      "flowStep.handleDependencies(handleDependencies)",
      undefined,
      expect.anything(),
      expect.stringMatching(/^EXEC core\.uspObjectDependencies /),
    )
    expectAuditProcedure(1, "DEV", { action: "syncDate", id: 791, objType: "Rule" })
    expectAuditProcedure(2, "UAT", { action: "deployDate", id: 791, objType: "Rule" })
  })

  it("registers pipeline activity on Agent", async () => {
    const progress = await runForEntity("pipelineActivity", 798, [PostMetadataActionKind.PipelineRegister])

    expect(stepNames(progress)).toEqual(["pipelineRegister"])
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/pipeline/register",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ pipelineId: 798 })
      })
    )
  })

  it("refreshes gate metadata then starts the list population pipeline", async () => {
    const progress = await runForEntity("gateMetadata", 780, [
      PostMetadataActionKind.MetaRefresh,
      PostMetadataActionKind.PipelineStart
    ])

    expect(stepNames(progress)).toEqual(["metaRefresh", "pipelineStart"])
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://gate.example/api/meta/refresh",
      expect.objectContaining({ method: "GET" })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://agent.example/pipeline/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "All Lists content item population" })
      })
    )
  })

  it("handles content dependencies explicitly", async () => {
    const progress = await runForEntity("content", 692, [PostMetadataActionKind.HandleDependencies])
    const request = trackedExecuteMock.mock.calls[0]?.[5] as unknown as {
      input: { mock: { calls: Array<[string, unknown, unknown]> } }
    }

    expect(stepNames(progress)).toEqual(["handleDependencies"])
    expect(trackedExecuteMock).toHaveBeenCalledWith(
      expect.anything(),
      "UAT",
      "core.uspObjectDependencies",
      "flowStep.handleDependencies(handleDependencies)",
      undefined,
      expect.anything(),
      expect.stringMatching(/^EXEC core\.uspObjectDependencies /),
    )
    expect(request.input.mock.calls.map(([name, , value]) => [name, value])).toEqual([
      ["id", 692],
      ["objectName", "content"]
    ])
  })

  it("runs the expanded explicit contract flow after metadata", async () => {
    const { progress } = await runScenario({
      entityType: "contract",
      entityId: 788,
      steps: contractSteps()
    })

    expect(stepNames(progress)).toEqual([
      "pipelineRegister",
      "contractUndeploy",
      "contractUnlockAfterUndeploy",
      "auditCheckPreDeploy",
      "contractLockForDeploy",
      "contractPreScript",
      "contractCreateDatasetStage",
      "contractCreateDatasetArchive",
      "contractCreateDatasetList",
      "contractCreateDatasetDim",
      "contractCreateDatasetFact",
      "contractCreateFks",
      "contractDeployEtl",
      "contractDeployRoutine",
      "contractPostScript",
      "contractUnlockAfterDeploy",
      "setSyncDate",
      "setDeployDate"
    ])
    expect(trackedQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      "UAT",
      "SELECT pipelineId FROM core.Pipeline WHERE contractId = @entityId",
      "targetSql.pipelineId(788)",
      undefined,
      expect.anything()
    )
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/pipeline/register",
      expect.objectContaining({ body: JSON.stringify({ pipelineId: 3525 }) })
    )
    expect(trackedQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      "UAT",
      expect.stringContaining("core.Contract"),
      expect.stringContaining("targetSql.name"),
      undefined,
      expect.anything()
    )
    expect(procedureCalls("core.uspUndeployMarkedContract")).toHaveLength(1)
    expect(procedureCalls("core.uspSetContractLock")).toHaveLength(3)
    expect(
      procedureCalls("core.uspAuditRunCheck").some(
        (call) =>
          call[1] === "DEV" &&
          auditParams(call).action === "syncOrNot" &&
          auditParams(call).id === 788 &&
          auditParams(call).objType === "Contract"
      )
    ).toBe(true)
    expect(procedureCalls("core.uspCreateDataset")).toHaveLength(5)
    expect(procedureCalls("core.uspCreateDatasetFKs")).toHaveLength(1)
    expect(procedureCalls("core.uspDeployETL2CustomTransformation")).toHaveLength(1)
    expect(procedureCalls("core.uspDeployRoutine")).toHaveLength(1)
    expect(procedureCalls("core.uspRunContractDeploymentScripts")).toHaveLength(2)
  })

  it("records a failed step and continues to later actions", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))
    const { progress, result } = await runScenario({
      entityType: "dataset",
      entityId: 792,
      actions: [PostMetadataActionKind.DatasetDeploy, PostMetadataActionKind.SyncDate]
    })

    expect(stepNames(progress)).toEqual(["datasetDeploy", "setSyncDate"])
    expect(progress.find((entry) => entry.deployStatus === "failed")).toMatchObject({
      step: "datasetDeploy",
      error: expect.stringContaining("500")
    })
    expect(result.stepWarnings).toEqual([
      expect.objectContaining({ step: "datasetDeploy", sproc: "direct" })
    ])
    expect(procedureCalls("core.uspAuditRunCheck")).toHaveLength(1)
  })

  it("skips ETL, routine, post-script, and FK when createDataset fails (contract fail-fast)", async () => {
    trackedExecuteMock.mockImplementation(async (_host, _conn, procedure, label) => {
      if (
        procedure === "core.uspCreateDataset" &&
        String(label).includes("contractCreateStageDataset")
      ) {
        throw new Error("duplicate pipelineRunId")
      }
      return { recordsets: [[{ status: "success", message: "ok" }]] } as never
    })

    const { progress, result } = await runScenario({
      entityType: "contract",
      entityId: 788,
      steps: contractSteps()
    })

    expect(procedureCalls("core.uspCreateDataset")).toHaveLength(5)
    expect(procedureCalls("core.uspCreateDatasetFKs")).toHaveLength(0)
    expect(procedureCalls("core.uspDeployETL2CustomTransformation")).toHaveLength(0)
    expect(procedureCalls("core.uspDeployRoutine")).toHaveLength(0)
    expect(
      progress.filter((entry) => entry.deployStatus === "skipped").map((entry) => entry.step)
    ).toEqual(
      expect.arrayContaining([
        "contractCreateFks",
        "contractDeployEtl",
        "contractDeployRoutine",
        "contractPostScript",
        "setDeployDate"
      ])
    )
    expect(result.stepWarnings.some((w) => w.sproc === "skipped")).toBe(true)
    expect(procedureCalls("core.uspSetContractLock")).toHaveLength(3)
  })
})

async function runForEntity(
  entityType: string,
  entityId: string | number,
  actions: PostMetadataActionKind[]
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
    planId: asPlanId("plan-1"),
    entityId: input.entityId,
    entityType: input.entityType,
    steps,
    flowCatalog: loadDeployFlowCatalogForTests(),
    onProgress: (entry) => progress.push(entry as unknown as Record<string, unknown>),
    userUpn: "user@example.com"
  })

  return { progress, result }
}

function contractSteps(): SyncExecutionContractStep[] {
  return [
    {
      id: "pipelineRegister",
      phase: "postMetadata",
      kind: "pipelineRegister",
      title: "Pipeline register",
      description: "Register affected pipelines with the target agent service.",
      bindings: { pipelineId: { type: "catalog", id: "contractPipelineId" } },
    },
    {
      id: "contractUndeploy",
      phase: "postMetadata",
      kind: "contractUndeploy",
      title: "Contract undeploy",
      description: "Undeploy the target contract before redeployment.",
    },
    {
      id: "contractUnlockAfterUndeploy",
      phase: "postMetadata",
      kind: "targetUnlock",
      title: "Unlock after undeploy",
      description: "Unlock the contract after undeploy.",
    },
    {
      id: "auditCheckPreDeploy",
      phase: "postMetadata",
      kind: "auditCheck",
      title: "Audit check (before deploy)",
      description: "Re-run source audit after undeploy, before physical dataset creation.",
      auditObjectType: "Contract",
    },
    {
      id: "contractLockForDeploy",
      phase: "postMetadata",
      kind: "targetLock",
      title: "Lock for deploy",
      description: "Lock the contract for deployment.",
    },
    {
      id: "contractPreScript",
      phase: "postMetadata",
      kind: "contractPreScript",
      title: "Pre-deploy script",
      description: "Run contract pre-deployment scripts.",
    },
    {
      id: "contractCreateDatasetStage",
      phase: "postMetadata",
      kind: "contractCreateStageDataset",
      title: "Create stage dataset",
      description: "Create the stage dataset.",
    },
    {
      id: "contractCreateDatasetArchive",
      phase: "postMetadata",
      kind: "contractCreateArchiveDataset",
      title: "Create archive dataset",
      description: "Create the archive dataset.",
    },
    {
      id: "contractCreateDatasetList",
      phase: "postMetadata",
      kind: "contractCreateListDataset",
      title: "Create list dataset",
      description: "Create the list dataset.",
    },
    {
      id: "contractCreateDatasetDim",
      phase: "postMetadata",
      kind: "contractCreateDimDataset",
      title: "Create dim dataset",
      description: "Create the dimension dataset.",
    },
    {
      id: "contractCreateDatasetFact",
      phase: "postMetadata",
      kind: "contractCreateFactDataset",
      title: "Create fact dataset",
      description: "Create the fact dataset.",
    },
    {
      id: "contractCreateFks",
      phase: "postMetadata",
      kind: "contractCreateDatasetFks",
      title: "Create dataset FKs",
      description: "Reconcile contract dataset foreign keys.",
    },
    {
      id: "contractDeployEtl",
      phase: "postMetadata",
      kind: "contractDeployEtl",
      title: "Deploy ETL",
      description: "Deploy ETL custom transformations.",
    },
    {
      id: "contractDeployRoutine",
      phase: "postMetadata",
      kind: "contractDeployRoutine",
      title: "Deploy routines",
      description: "Deploy contract routines.",
    },
    {
      id: "contractPostScript",
      phase: "postMetadata",
      kind: "contractPostScript",
      title: "Post-deploy script",
      description: "Run contract post-deployment scripts.",
    },
    {
      id: "contractUnlockAfterDeploy",
      phase: "postMetadata",
      kind: "targetUnlock",
      title: "Unlock after deploy",
      description: "Unlock the contract after deployment.",
    },
    {
      id: "setSyncDate",
      phase: "postMetadata",
      kind: "syncDate",
      title: "Sync date",
      description: "Stamp the contract sync date.",
      auditObjectType: "Contract",
    },
    {
      id: "setDeployDate",
      phase: "postMetadata",
      kind: "deployDate",
      title: "Deploy date",
      description: "Stamp the contract deploy date.",
      auditObjectType: "Contract",
    },
  ]
}

function stepNames(progress: Array<Record<string, unknown>>): string[] {
  const names: string[] = []
  for (const entry of progress) {
    if (typeof entry.step !== "string") continue
    if (entry.type === "deploy-step" && entry.deployStatus !== "started") continue
    names.push(entry.step)
  }
  return names
}

function createPlan(entityType: string, actions: PostMetadataActionKind[]): SyncPlan {
  return {
    planId: asPlanId("plan-1"),
    createdAt: new Date(0).toISOString(),
    createdAtMs: 0,
    entity: { type: entityType as never, id: 1, displayName: entityType },
    source: "DEV",
    target: "UAT",
    preflight: {
      catalogCompatible: true,
      issues: [],
      rootParentReady: true,
      rootParentIssue: null,
    },
    tables: [],
    totals: { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0, tablesCount: 0 },
    dependencyGraph: { nodes: [], edges: [] },
    warnings: [],
    estimatedDurationSec: 0,
    executionContract: {
      definitionId: entityType,
      definitionPublishedVersion: "v1",
      definitionPublishedAt: new Date(0).toISOString(),
      governance: { freezeWindowIds: [] },
      bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
      allowedSchemas: [],
      metadata: {
        rootTable: "",
        rootKeyColumn: "",
        selfJoinColumn: null,
        tables: [],
        executionOrder: [],
        reverseOrder: []
      },
      flow: { steps: createSteps(entityType, actions) },
      provenance: { kind: "manual" }
    }
  }
}

function stepBindings(
  entityType: string,
  kind: PostMetadataActionKind,
): Record<string, import("@mia/shared-types").ValueSource> {
  if (kind === PostMetadataActionKind.DatasetDeploy) {
    return {
      datasetId:
        entityType === "rule" ? { type: "catalog", id: "ruleInputDatasetId" } : { type: "catalog", id: "planEntityId" },
    }
  }
  if (kind === PostMetadataActionKind.PipelineRegister) {
    return {
      pipelineId:
        entityType === "pipelineActivity"
          ? { type: "catalog", id: "planEntityId" }
          : { type: "catalog", id: "contractPipelineId" },
    }
  }
  return {}
}

function createSteps(entityType: string, actions: PostMetadataActionKind[]): SyncExecutionContractStep[] {
  return actions.map((kind) => ({
    id: stepId(kind),
    phase: "postMetadata",
    kind,
    title: kind,
    description: kind,
    bindings: stepBindings(entityType, kind),
    objectName: kind === PostMetadataActionKind.HandleDependencies ? entityType.toLowerCase() : null,
    auditObjectType:
      kind === PostMetadataActionKind.SyncDate || kind === PostMetadataActionKind.DeployDate
        ? ({
            dataset: "Dataset",
            rule: "Rule",
            content: "Content",
            "pipelineActivity": "Pipeline",
            "gateMetadata": "MetaTable",
            contract: "Contract"
          }[entityType] ?? entityType)
        : null,
    pipelineName: kind === PostMetadataActionKind.PipelineStart ? "All Lists content item population" : null
  }))
}

function stepId(kind: PostMetadataActionKind): string {
  switch (kind) {
    case PostMetadataActionKind.DatasetDeploy:
      return "datasetDeploy"
    case PostMetadataActionKind.RulesDeploy:
      return "rulesDeploy"
    case PostMetadataActionKind.PipelineRegister:
      return "pipelineRegister"
    case PostMetadataActionKind.MetaRefresh:
      return "metaRefresh"
    case PostMetadataActionKind.PipelineStart:
      return "pipelineStart"
    case PostMetadataActionKind.HandleDependencies:
      return "handleDependencies"
    case PostMetadataActionKind.SyncDate:
      return "setSyncDate"
    case PostMetadataActionKind.DeployDate:
      return "setDeployDate"
    default:
      return String(kind)
  }
}

function createHost(): SyncRuntimeHost {
  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: null }
    },
    sync: {
      events: { sink: vi.fn() },
      runs: {
        sink: {
          start: vi.fn(),
          finish: vi.fn()
        },
        actorUpn: null
      },
      project: {
        dbProjectRoot: null,
        publishedDefinitions: createPublishedSyncDefinitionRegistry(),
        publishReadiness: ALWAYS_PUBLISH_READY,
      },
      environments: {
        items: new Map([
          [
            "DEV",
            {
              name: "DEV",
              displayName: "DEV",
              color: "blue",
              role: "both",
              ringOrder: 0,
              agentServiceBaseUrl: "https://agent.example",
              etlServiceBaseUrl: "https://etl.example",
              gateServiceBaseUrl: "https://gate.example",
              allowedSyncEnvironments: null,
              defaultAccessMode: "read_write",
              allowedOperations: ["query_read", "schema_introspect", "sync_preview", "sync_execute", "dml"],
              denyDml: false,
              denyDdl: false,
              approvalRequiredOperations: ["sync_execute"]
            }
          ],
          [
            "UAT",
            {
              name: "UAT",
              displayName: "UAT",
              color: "amber",
              role: "both",
              ringOrder: 1,
              agentServiceBaseUrl: "https://agent.example",
              etlServiceBaseUrl: "https://etl.example",
              gateServiceBaseUrl: "https://gate.example",
              allowedSyncEnvironments: null,
              defaultAccessMode: "read_only",
              allowedOperations: ["query_read", "schema_introspect", "sync_preview"],
              denyDml: true,
              denyDdl: true,
              approvalRequiredOperations: ["sync_execute"]
            }
          ]
        ])
      },
      plans: { diskRoot: null, memCache: new Map() }
    }
  }
}

function procedureCalls(procedure: string) {
  return vi.mocked(trackedExecute).mock.calls.filter((call) => call[2] === procedure)
}

function requestParams(req: unknown): Array<[string, unknown]> {
  const request = req as { input: { mock: { calls: Array<[string, unknown, unknown]> } } }
  return request.input.mock.calls.map(([name, , value]) => [name, value])
}

function auditParams(call: unknown[]): Record<string, unknown> {
  const params = Object.fromEntries(requestParams(call[5]))
  return {
    action: params["action"],
    id: params["id"],
    objType: params["objType"]
  }
}

function expectAuditProcedure(
  nth: number,
  connection: string,
  expected: { action: string; id: number; objType: string }
) {
  const calls = procedureCalls("core.uspAuditRunCheck")
  const call = calls[nth - 1]
  expect(call?.[1]).toBe(connection)
  expect(auditParams(call ?? [])).toMatchObject(expected)
}

function createPool(): ConnectionPool {
  return {
    request: () => {
      const request = {
        input: vi.fn()
      }
      request.input.mockReturnValue(request)
      return request
    }
  } as unknown as ConnectionPool
}
