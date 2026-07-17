import { existsSync, readFileSync } from "node:fs"

import { catalogSnapshotFromAgentJson, type CatalogSnapshotForSuggest } from "@mia/sync"

import {
  resolveCatalogCacheBasePath,
  resolveCatalogCachePath,
} from "../../../infra/catalog/catalog-cache-path.js"

function resolveCatalogCachePaths(): string[] {
  const paths: string[] = [resolveCatalogCacheBasePath()]
  for (const suffix of ["uat", "dev", "default"]) {
    paths.push(resolveCatalogCachePath(suffix, [suffix, "other"]))
  }
  return [...new Set(paths)]
}

export function loadCatalogSnapshotForSuggest(): CatalogSnapshotForSuggest | null {
  for (const path of resolveCatalogCachePaths()) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
      const snapshot = catalogSnapshotFromAgentJson(raw)
      if (snapshot) return snapshot
    } catch (error) {
      console.warn(
        `[entity-registry] failed to read catalog cache ${path}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }
  return null
}
