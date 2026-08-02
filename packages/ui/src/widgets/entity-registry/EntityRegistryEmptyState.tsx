/**
 * Entity Registry — idle workspace placeholder when no entity is selected.
 */

import { Layers, Plus } from "lucide-react"
import type { JSX } from "react"
import { ACTION_BTN } from "./chrome"

export interface EntityRegistryEmptyStateProps {
  isAdmin: boolean
  onCreate: () => void
}

export function EntityRegistryEmptyState({
  isAdmin,
  onCreate,
}: EntityRegistryEmptyStateProps): JSX.Element {
  return (
    <div className="entity-registry-workspace-empty">
      <div className="entity-registry-empty-card">
        <div className="entity-registry-empty-card__icon">
          <Layers size={16} strokeWidth={1.75} aria-hidden />
          <span>Entity</span>
        </div>
        <h2 className="entity-registry-empty-card__title">Select an Entity</h2>
        <p className="entity-registry-empty-card__detail">
          Choose an entity from the left sidebar to view schema definitions, rules, and activity streams.
        </p>
        {isAdmin && (
          <button type="button" onClick={onCreate} className={ACTION_BTN}>
            <Plus size={14} aria-hidden />
            Create New Entity
          </button>
        )}
      </div>
    </div>
  )
}
