import { describe, expect, it, vi } from "vitest"

vi.mock("../../../infra/persistence/sqlite.js", () => ({
  listEvents: vi.fn(async () => [
    {
      id: 1,
      type: "api.request",
      data: JSON.stringify({ severity: "info" }),
      created_at: "2026-08-06T16:10:00.000Z",
      actor_upn: "a@x.com",
      run_id: null,
      plan_id: null,
    },
    {
      id: 2,
      type: "sync.preview.started",
      data: JSON.stringify({}),
      created_at: "2026-08-06T16:40:00.000Z",
      actor_upn: "a@x.com",
      run_id: null,
      plan_id: null,
    },
    {
      id: 3,
      type: "run.failed",
      data: JSON.stringify({ severity: "error" }),
      created_at: "2026-08-06T16:40:01.000Z",
      actor_upn: "other@x.com",
      run_id: null,
      plan_id: null,
    },
  ]),
}))

import { buildEventHistogram } from "./histogram.js"

describe("buildEventHistogram", () => {
  it("buckets by lane and respects viewing-as", async () => {
    const result = await buildEventHistogram({
      since: "2026-08-06T16:00:00.000Z",
      until: "2026-08-06T17:00:00.000Z",
      bucketCount: 4,
      viewingAsUpn: "a@x.com",
    })
    expect(result.totalCount).toBe(2)
    expect(result.truncated).toBe(false)
    const apiBucket = result.buckets.find((b) => b.byLane.api > 0)
    const syncBucket = result.buckets.find((b) => b.byLane.sync > 0)
    expect(apiBucket?.count).toBe(1)
    expect(syncBucket?.byLane.sync).toBe(1)
  })
})
