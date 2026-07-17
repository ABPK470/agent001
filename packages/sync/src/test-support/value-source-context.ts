import type { ConnectionPool } from "mssql"
import { vi } from "vitest"

import type { FlowStepRunContext } from "../runtime/orchestrator/flow-step-executor.js"
import { StepOutputRegistry } from "../runtime/orchestrator/step-output-registry.js"
import { TEST_VALUE_SOURCE_CATALOG } from "./value-source-catalog.js"

export function testFlowStepRunContext(
  overrides?: Partial<FlowStepRunContext>,
): FlowStepRunContext {
  const stepOutputs = new StepOutputRegistry()
  return {
    host: {} as never,
    plan: { source: "DEV", target: "UAT" } as never,
    entityId: 788,
    entityType: "contract",
    srcPool: { request: () => ({ input: vi.fn() }) } as unknown as ConnectionPool,
    tgtPool: { request: () => ({ input: vi.fn() }) } as unknown as ConnectionPool,
    resolveContractName: async () => "MyContract",
    customValueSources: TEST_VALUE_SOURCE_CATALOG,
    stepOutputs,
    ...overrides,
  }
}
