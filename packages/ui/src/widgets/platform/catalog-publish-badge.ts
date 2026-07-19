/**
 * Active catalog version badge — stamp equality is the only "published" truth.
 */

export type ActivePublishBadgeModel = {
  label: "published" | "publish pending" | "env ahead"
  tone: "success" | "warning" | "info"
  title: string
}

export function activePublishBadge(args: {
  version: number
  publishedCatalogVersion: number | null
  needsPublish: boolean
  operationalAhead: boolean
}): ActivePublishBadgeModel {
  const stampMatches =
    args.publishedCatalogVersion != null && args.version === args.publishedCatalogVersion
  if (stampMatches) {
    return {
      label: "published",
      tone: "success",
      title: "Active tip stamp matches the last Publish",
    }
  }
  if (args.needsPublish) {
    return {
      label: "publish pending",
      tone: "warning",
      title: args.publishedCatalogVersion != null
        ? `Active catalog v${args.version} — sync bundle still from v${args.publishedCatalogVersion}`
        : "Active catalog has changes not yet compiled into the sync runtime bundle",
    }
  }
  if (args.operationalAhead) {
    return {
      label: "env ahead",
      tone: "info",
      title: "Tip ahead for environments only — live at preview/execute, Publish not required",
    }
  }
  return {
    label: "publish pending",
    tone: "warning",
    title: args.publishedCatalogVersion != null
      ? `Active catalog v${args.version} — sync bundle still from v${args.publishedCatalogVersion}`
      : "Publish required",
  }
}
