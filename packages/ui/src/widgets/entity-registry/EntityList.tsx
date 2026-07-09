/**
 * Entity sidebar list — thread-rail row pattern.
 */

import type { JSX } from "react"
import type { EntityRegistryDefinition } from "../../types"
import { Empty } from "../sync-admin/shared"
import { EntityRailItem } from "./EntityRailItem"

export interface EntityListProps {
  items: EntityRegistryDefinition[]
  selectedId: string | null
  isAdmin: boolean
  busy: boolean
  onSelect: (id: string) => void
  onHistory: (entity: EntityRegistryDefinition) => void
  onEdit: (entity: EntityRegistryDefinition) => void
  onRetire: (entity: EntityRegistryDefinition) => void
}

export function EntityList({
  items,
  selectedId,
  isAdmin,
  busy,
  onSelect,
  onHistory,
  onEdit,
  onRetire,
}: EntityListProps): JSX.Element {
  if (items.length === 0) return <Empty title="No entities" />

  return (
    <ul className="entity-rail-list" aria-label="Entities">
      {items.map((entity) => (
        <EntityRailItem
          key={entity.id}
          entity={entity}
          active={selectedId === entity.id}
          isAdmin={isAdmin}
          busy={busy}
          onSelect={() => onSelect(entity.id)}
          onHistory={() => onHistory(entity)}
          onEdit={() => onEdit(entity)}
          onRetire={() => onRetire(entity)}
        />
      ))}
    </ul>
  )
}
