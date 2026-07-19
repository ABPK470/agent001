import { describe, expect, it } from "vitest"
import { activePublishBadge } from "./catalog-publish-badge"

describe("activePublishBadge", () => {
  it("is published only when tip stamp equals publish stamp", () => {
    expect(activePublishBadge({
      version: 4,
      publishedCatalogVersion: 4,
      needsPublish: false,
      operationalAhead: false,
    }).label).toBe("published")
  })

  it("never shows published when tip stamp is ahead of publish", () => {
    expect(activePublishBadge({
      version: 7,
      publishedCatalogVersion: 4,
      needsPublish: false,
      operationalAhead: false,
    }).label).toBe("publish pending")

    expect(activePublishBadge({
      version: 7,
      publishedCatalogVersion: 4,
      needsPublish: true,
      operationalAhead: false,
    }).label).toBe("publish pending")
  })

  it("shows env ahead when operational tip and Publish not required", () => {
    expect(activePublishBadge({
      version: 8,
      publishedCatalogVersion: 4,
      needsPublish: false,
      operationalAhead: true,
    })).toMatchObject({ label: "env ahead", tone: "info" })
  })

  it("prefers publish pending over env ahead when Publish is armed", () => {
    expect(activePublishBadge({
      version: 8,
      publishedCatalogVersion: 4,
      needsPublish: true,
      operationalAhead: true,
    }).label).toBe("publish pending")
  })

  it("never published when there is no publish stamp yet", () => {
    expect(activePublishBadge({
      version: 1,
      publishedCatalogVersion: null,
      needsPublish: true,
      operationalAhead: false,
    }).label).toBe("publish pending")
  })
})
