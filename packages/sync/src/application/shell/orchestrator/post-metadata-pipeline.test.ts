import type { ConnectionPool } from "mssql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PostMetadataActionKind } from "../../../domain/enums.js"
import type { AgentHost } from "../../../ports/host.js"
import type { SyncPlan } from "../plan-store.js"
import { runAuditCheckDirect } from "./contract-deploy.js"
import { trackedExecute, trackedQuery } from "./db-helpers.js"
import { runContractPipeline } from "./execute-pipeline.js"
import { runPostMetadataPipeline } from "./post-metadata-pipeline.js"

vi.mock("./db-helpers.js", () => ({
  trackedExecute: vi.fn(),
  trackedQuery: vi.fn(),
}))

vi.mock("./contract-deploy.js", () => ({
  runAuditCheckDirect: vi.fn(),
}))

vi.mock("./execute-pipeline.js", () => ({
  runContractPipeline: vi.fn(),
}))

describe("runPostMetadataPipeline", () => {
  const trackedQueryMock = vi.mocked(trackedQuery)
  const trackedExecuteMock = vi.mocked(trackedExecute)
  const runAuditCheckDirectMock = vi.mocked(runAuditCheckDirect)
  const runContractPipelineMock = vi.mocked(runContractPipeline)
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    trackedExecuteMock.mockResolvedValue({} as never)
    trackedQueryMock.mockResolvedValue({ recordset: [] } as never)
    runAuditCheckDirectMock.mockResolvedValue({} as never)
    runContractPipelineMock.mockResolvedValue({ stepWarnings: [] })
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

  it("registers the contract pipeline before contract deployment", async () => {
    trackedQueryMock.mockResolvedValueOnce({ recordset: [{ pipelineId: 3525 }] } as never)
    const progress = await runForEntity("contract", 788, [
      PostMetadataActionKind.PipelineRegister,
      PostMetadataActionKind.ContractDeploy,
    ])

    expect(stepNames(progress)).toEqual(["pipeline-register"])
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
    expect(runContractPipelineMock).toHaveBeenCalledOnce()
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
  actions: PostMetadataActionKind[]
}) {
  const progress: Array<Record<string, unknown>> = []
  const host = createHost()

  const result = await runPostMetadataPipeline({
    host,
    srcPool: createPool(),
    tgtPool: createPool(),
    plan: createPlan(input.entityType, input.actions),
    planId: "plan-1",
    entityId: input.entityId,
    entityType: input.entityType,
    onProgress: (entry) => progress.push(entry as unknown as Record<string, unknown>),
    userUpn: "user@example.com",
  })

  return { progress, result }
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
      postMetadataActions: actions.map((kind) => ({ kind })),
    },
  }
}

function createHost(): AgentHost {
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
      recipes: { bundle: null, loadedFromPath: null },
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