import { customValueSourceCatalogFromRows } from "@mia/shared-types"

import { VALUE_SOURCE_SEEDS } from "../../../../deploy/sync/helpers/value-source-seeds.mjs"

/** Full shipped catalog for orchestrator unit tests. */
export const TEST_VALUE_SOURCE_CATALOG = customValueSourceCatalogFromRows(
  VALUE_SOURCE_SEEDS.map((entry) => ({
    id: entry.id,
    definition: entry.definition,
  })),
)
