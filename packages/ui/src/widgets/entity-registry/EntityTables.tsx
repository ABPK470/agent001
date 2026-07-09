/**
 * Tables tab — compact list with drill-down detail (same UX as Overview → Tables section).
 */

import { useMemo, type JSX } from "react"
import type { EntityRegistryDefinition } from "../../types"
import { EntityTablesExplorer } from "./EntityTablesExplorer"

export interface EntityTablesProps {
  def: EntityRegistryDefinition
}

export function EntityTables({ def }: EntityTablesProps): JSX.Element {
  const tables = useMemo(() => def.tables ?? [], [def.tables])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3">
      <div className="min-h-0 flex-1 overflow-auto">
        <EntityTablesExplorer
          tables={tables}
          emptyMessage="No tables — add them via Edit."
        />
      </div>
    </div>
  )
}
