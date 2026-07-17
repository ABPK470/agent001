import { buildCatalog, getMssqlConfig, type AgentHost, type LLMClient } from "@mia/agent"
import { buildLlmClient } from "../platform/llm/registry.js"
import { resolveCatalogCachePath } from "../platform/catalog/catalog-cache-path.js"
import { getLlmConfig } from "../platform/persistence/index.js"

export async function buildLlmAndCatalog(
  host: AgentHost,
  mssqlSummary: string,
): Promise<LLMClient> {
  const llmCfg = getLlmConfig()
  const llm = buildLlmClient(llmCfg)
  console.log(`LLM: ${llmCfg.provider} / ${llmCfg.model}`)

  if (mssqlSummary !== "not configured") {
    try {
      const maxAgeHours = Number(process.env.CATALOG_MAX_AGE_HOURS || 168)
      const configs = getMssqlConfig(host)
      const conns = configs.length > 0 ? configs.map((c) => c.name) : ["default"]

      for (const conn of conns) {
        const cachePath = resolveCatalogCachePath(conn, conns)
        host.catalog.defaultCachePath.value = cachePath
        console.log(`Loading schema catalog for "${conn}" (cache: ${cachePath}, max age: ${maxAgeHours}h)...`)
        try {
          const catalog = await buildCatalog(host, {
            connection: conn,
            cachePath,
            maxAgeMs: maxAgeHours * 3600_000,
          })
          const stats = catalog.stats()
          const ageH = Math.round((Date.now() - catalog.builtAt.getTime()) / 3600000)
          const source = ageH < 1 ? "built fresh from MSSQL" : `loaded from cache (${ageH}h old)`
          console.log(
            `Catalog [${conn}] ${source}: ${stats.schemas} schemas, ${stats.tables} tables, ${stats.views} views, ${stats.columns} columns, ${stats.fks} FKs`,
          )
        } catch (error) {
          console.warn(
            `Failed to build catalog for "${conn}":`,
            error instanceof Error ? error.message : error,
          )
        }
      }
    } catch (error) {
      console.warn("Failed to build schema catalog:", error instanceof Error ? error.message : error)
    }
  }

  return llm
}
