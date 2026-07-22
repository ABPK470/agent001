import { describe, expect, it } from "vitest"

import {
  ALWAYS_PUBLISH_READY,
  assertPublishedContractCurrent,
  isSyncPublishRequiredError,
  PUBLISH_REQUIRED_CODE,
  SyncPublishRequiredError,
} from "./publish-readiness.js"

describe("publish-readiness", () => {
  it("ALWAYS_PUBLISH_READY never blocks", () => {
    expect(() => assertPublishedContractCurrent(ALWAYS_PUBLISH_READY, "contract")).not.toThrow()
  })

  it("throws SyncPublishRequiredError with stable code when tip is ahead", () => {
    expect(() =>
      assertPublishedContractCurrent({ entityNeedsRepublish: () => true }, "contract"),
    ).toThrow(SyncPublishRequiredError)

    try {
      assertPublishedContractCurrent({ entityNeedsRepublish: () => true }, "contract")
    } catch (error) {
      expect(isSyncPublishRequiredError(error)).toBe(true)
      if (isSyncPublishRequiredError(error)) {
        expect(error.code).toBe(PUBLISH_REQUIRED_CODE)
        expect(error.entityType).toBe("contract")
        expect(error.message).toMatch(/Publish from Entity Registry/)
      }
    }
  })
})
